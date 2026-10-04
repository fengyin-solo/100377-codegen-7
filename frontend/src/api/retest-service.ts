import {
  acquireLock,
  listRows,
  notifyStorageChanged,
  readJson,
  releaseLock,
  retestStorageKey,
  saveRowsBatch,
  subscribeStorage,
  writeJson,
} from '@/data/local-store'
import type {
  ActionResult,
  BatchSummary,
  ChecklistPreviewRow,
  EntryRow,
  RetestBatch,
  RetestDraft,
  RetestItem,
  RetestItemStatus,
  RetestState,
  RetestSubmitRequest,
  RetestSubmitResult,
  StatsRule,
} from '@/data/types'

const CROSS_KEY = 'crosssection'
const STATIONHOUSE_KEY = 'stationhouse'

// 可安排进复测批次的断面：已测量 / 待校核（兼容历史待校核记录）/ 需重测。
const RETEST_SOURCE_STATUSES = ['已测量', '待校核', '需重测']

const EMPTY_STATE: RetestState = { seq: 0, rule: 'narrow', batches: [] }

/**
 * 进程内提交队列：同一标签页里两个并发提交（双击 / Promise.all 模拟双终端）
 * 也必须串行进入临界区，与跨标签页的 localStorage 锁叠加成双保险。
 */
let submitChain: Promise<RetestSubmitResult> = Promise.resolve({
  ok: false,
  message: '',
  duplicated: false,
  batch: null,
})

function enqueueSubmit(task: () => Promise<RetestSubmitResult>): Promise<RetestSubmitResult> {
  const run = submitChain.then(task, task)
  // 队列本身不因单个任务失败而中断后续提交。
  submitChain = run.then(
    () => ({ ok: false, message: '', duplicated: false, batch: null }),
    () => ({ ok: false, message: '', duplicated: false, batch: null }),
  )
  return run
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function field(row: EntryRow, name: string): string {
  return String(row[name] ?? '')
}

function loadState(): RetestState {
  const state = readJson<RetestState>(retestStorageKey(), EMPTY_STATE)
  return {
    seq: state.seq ?? 0,
    rule: state.rule === 'wide' ? 'wide' : 'narrow',
    batches: Array.isArray(state.batches) ? state.batches : [],
  }
}

function saveState(state: RetestState): void {
  writeJson(retestStorageKey(), state)
  notifyStorageChanged()
}

// 页面订阅复测批次/断面/站房待办在本终端或另一终端的变更，自动刷新。
export { subscribeStorage }

// ---------- 统计口径 ----------

export function currentStatsRule(): StatsRule {
  return loadState().rule
}

function computeSummary(batch: RetestBatch, rule: StatsRule): BatchSummary {
  const items = batch.items
  const finished = items.filter((item) => item.status === '复测完成-待校核')
  const itemIds = new Set(items.map((item) => item.crossId))
  const rows = listRows(CROSS_KEY)
  // 窄口径：只数本次重测产出、仍在「复测完成-待校核」的断面（已校核通过的不再算）。
  // 宽口径：再加上同河历史待校核、且本次没有安排重测的清单项（按断面实时状态，只计一次）。
  const historicalOpen =
    rule === 'wide'
      ? batch.checklistIds.filter((crossId) => {
          if (itemIds.has(crossId)) {
            return false
          }
          const row = rows.find((candidate) => Number(candidate.id) === crossId)
          return row !== undefined && String(row.status) === '待校核'
        }).length
      : 0
  const pendingCheck = finished.length + historicalOpen
  return {
    total: items.length,
    pending: items.filter((item) => item.status === '待复测').length,
    finished: finished.length,
    failed: items.filter((item) => item.status === '复测失败').length,
    passed: items.filter((item) => item.status === '校核通过').length,
    pendingCheck,
  }
}

function refreshSummaries(batches: RetestBatch[], rule: StatsRule): void {
  for (const batch of batches) {
    if (batch.status === '已归档') {
      continue // 已归档批次冻结在归档时的口径，规则调整不再重算。
    }
    batch.summary = computeSummary(batch, rule)
  }
}

/**
 * 调整统计规则：立即重算全部「未归档」批次的复测摘要，已归档批次保持原快照不动。
 */
export function updateStatsRule(rule: StatsRule): ActionResult & { recomputed: number } {
  const state = loadState()
  if (state.rule === rule) {
    return { ok: true, message: '统计规则未变化', recomputed: 0 }
  }
  const targets = state.batches.filter((batch) => batch.status !== '已归档')
  refreshSummaries(targets, rule)
  state.rule = rule
  saveState(state)
  return {
    ok: true,
    message:
      rule === 'wide'
        ? '已切换为宽口径（校核清单口径），未归档批次摘要已重算'
        : '已切换为窄口径（仅本次重测口径），未归档批次摘要已重算',
    recomputed: targets.length,
  }
}

// ---------- 选择与校核清单预览 ----------

function crossRows(): EntryRow[] {
  return listRows(CROSS_KEY)
}

/**
 * 生成成组复测的预览草案，但不落库：
 * 校验必须多选、必须同一条河流；同河混合管理单位是允许的，仅在清单里分列提示。
 */
export function buildRetestDraft(crossIds: number[]): RetestDraft {
  const result = validateSelection(crossIds)
  if (!result.ok) {
    return result.draft
  }
  const river = result.draft.river
  // 页面草案预览：提示已被进行中批次占用的断面；真正的拦截在提交锁内（幂等优先于占用）。
  const busy = new Set<number>()
  for (const batch of loadState().batches) {
    if (batch.status === '进行中') {
      batch.items.forEach((item) => busy.add(item.crossId))
    }
  }
  const occupied = result.selected.find((row) => busy.has(Number(row.id)))
  if (occupied) {
    return {
      ok: false,
      message: `断面「${field(occupied, '断面名称')}」已在一个进行中的复测批次里，完成或归档后再安排`,
      river,
      units: [],
      checklist: [],
    }
  }
  return result.draft
}

/**
 * 提交路径使用的基础校验：存在性、可安排状态、同一条河流。
 * 刻意不含「进行中批次占用」——占用判定必须放在锁内、幂等判定之后，
 * 否则两个终端并发提交同一安排时，后到者在幂等之前就被挡下，无法返回原批次。
 */
function validateSelection(crossIds: number[]): { ok: boolean; draft: RetestDraft; selected: EntryRow[] } {
  const fail = (message: string) => ({
    ok: false,
    selected: [] as EntryRow[],
    draft: { ok: false, message, river: '', units: [], checklist: [] } as RetestDraft,
  })
  const ids = [...new Set(crossIds)]
  if (ids.length === 0) {
    return fail('请先勾选需要安排复测的断面')
  }
  const rows = crossRows()
  const selected = ids
    .map((id) => rows.find((row) => Number(row.id) === id))
    .filter((row): row is EntryRow => Boolean(row))
  if (selected.length !== ids.length) {
    return fail('所选断面中有记录已不存在，请刷新后重选')
  }
  const bad = selected.find((row) => !RETEST_SOURCE_STATUSES.includes(String(row.status)))
  if (bad) {
    return fail(`断面「${field(bad, '断面名称')}」当前为${bad.status}，不在可安排复测范围`)
  }
  const rivers = [...new Set(selected.map((row) => field(row, '所在河流')).filter(Boolean))]
  if (rivers.length !== 1) {
    return fail(`所选断面必须属于同一条河流，当前涉及：${rivers.join('、') || '未填写河流'}`)
  }
  return { ok: true, selected, draft: buildChecklistDraft(rivers[0], selected) }
}

/** 校核清单：本次选中的断面 + 同河所有历史待校核断面（含未选中的），按单位分列。 */
function buildChecklistDraft(river: string, selected: EntryRow[]): RetestDraft {
  const rows = crossRows()
  const chosenIds = new Set(selected.map((row) => Number(row.id)))
  const checklist: ChecklistPreviewRow[] = selected.map((row) => ({
    crossId: Number(row.id),
    recordNo: field(row, '记录编号'),
    stationNo: field(row, '站点编号'),
    section: field(row, '断面名称'),
    unit: field(row, '管理单位'),
    status: String(row.status),
    source: '本次重测',
  }))
  for (const row of rows) {
    const crossId = Number(row.id)
    if (field(row, '所在河流') === river && String(row.status) === '待校核' && !chosenIds.has(crossId)) {
      checklist.push({
        crossId,
        recordNo: field(row, '记录编号'),
        stationNo: field(row, '站点编号'),
        section: field(row, '断面名称'),
        unit: field(row, '管理单位'),
        status: String(row.status),
        source: '历史待校核',
      })
    }
  }
  const units = [...new Set(checklist.map((row) => row.unit).filter(Boolean))]
  return { ok: true, message: '', river, units, checklist }
}

/** 幂等键：同一河流 + 同一组断面 + 同一天只允许安排一次。 */
export function makeIdemKey(river: string, crossIds: number[], date: string): string {
  return `${date}|${river}|${[...new Set(crossIds)].sort((a, b) => a - b).join('-')}`
}

// ---------- 批次落库 ----------

function buildItem(row: EntryRow): RetestItem {
  return {
    id: `RT-${row.id}-${Date.now()}`,
    crossId: Number(row.id),
    recordNo: field(row, '记录编号'),
    stationNo: field(row, '站点编号'),
    section: field(row, '断面名称'),
    unit: field(row, '管理单位'),
    preexistingPending: String(row.status) === '待校核',
    status: '待复测',
    failReason: '',
    attempts: 0,
    updatedAt: now(),
  }
}

function stationhouseTodoRow(params: {
  id: number
  stationNo: string
  river: string
  batchNo: string
  unit: string
  plannedDate: string
}): EntryRow {
  // 成组复测外业要同时通知站房配合：腾让断面、缆道配合、夜间照明等。
  return {
    id: params.id,
    status: '待安排',
    pending: true,
    abnormal: false,
    记录编号: `RT-COORD-${String(params.id).padStart(4, '0')}`,
    站点编号: params.stationNo,
    维护类型: '复测配合',
    维护内容: `配合复测批次${params.batchNo}（${params.river}）安排断面复测外业配合事项`,
    维护单位: params.unit,
    维护日期: params.plannedDate,
    费用支出: 0,
    维护状态: '待安排',
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 成组复测批次落库。
 * - 幂等：同 idemKey 已提交则直接返回原批次（另一终端先提交 / 双击 / 双终端并发都只生效一次）。
 * - 互斥：跨标签页 localStorage 锁，拿不到就等一拍重试，仍拿不到报忙。
 * - 拿到锁但断面已被并发占用时让位，等先到者提交完成后重新判定幂等。
 * - 断面记录置为「需重测」，同河站房新增复测配合待办，一次事务落库。
 */
export async function submitRetestBatch(
  request: RetestSubmitRequest,
): Promise<RetestSubmitResult> {
  return enqueueSubmit(() => submitRetestBatchLocked(request))
}

async function submitRetestBatchLocked(
  request: RetestSubmitRequest,
): Promise<RetestSubmitResult> {
  // 提交路径只做基础校验；占用判定放到锁内、幂等判定之后。
  const validation = validateSelection(request.crossIds)
  if (!validation.ok) {
    return { ok: false, message: validation.draft.message, duplicated: false, batch: null }
  }
  const draft = validation.draft

  const holder = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // 外层循环：锁竞争 / 并发占用时让位于先到终端，重新判定幂等。
  for (let turn = 0; turn < 8; turn += 1) {
    let locked = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (acquireLock(holder)) {
        locked = true
        break
      }
      await wait(120)
    }
    if (!locked) {
      return {
        ok: false,
        message: '另一终端正在提交复测安排，请稍后再试（并发互斥）',
        duplicated: false,
        batch: null,
      }
    }

    try {
      // 拿到锁后重读：另一个终端可能已经把同一安排落库了。
      const before = loadState()
      const dup = before.batches.find((batch) => batch.idemKey === request.idemKey)
      if (dup) {
        return {
          ok: false,
          message: `该复测安排已由另一终端提交为批次 ${dup.batchNo}，本次提交不重复生效`,
          duplicated: true,
          batch: dup,
        }
      }
      // 再查一次断面占用，防止两终端选了不同子集但断面重叠。
      const busy = new Set<number>()
      for (const batch of before.batches) {
        if (batch.status === '进行中') {
          batch.items.forEach((item) => busy.add(item.crossId))
        }
      }
      const clash = request.crossIds.find((crossId) => busy.has(crossId))
      if (clash) {
        // 同一进程/终端内两个并发提交会同时抢锁：先到者尚未提交时后到者先看到占用，
        // 让一拍后先到者已落库，回到上面按幂等键返回原批次，保证只生效一次。
        await wait(120)
        continue
      }

      const rows = crossRows()
      const items = validation.selected.map(buildItem)

      // 断面统一进入「需重测」，等复测台逐条完成后再回待校核/已校核。
      const nextCross = rows.map((row) => {
        if (!request.crossIds.includes(Number(row.id))) {
          return row
        }
        return { ...row, status: '需重测', pending: true, abnormal: false }
      })

      // 每个涉及站房新增一条复测配合待办，按站点编号去重。
      const stationSet = new Map<string, string>()
      for (const item of items) {
        if (!stationSet.has(item.stationNo)) {
          stationSet.set(item.stationNo, item.unit)
        }
      }
      const stationRows = listRows(STATIONHOUSE_KEY)
      let todoSeq = stationRows.reduce((max, row) => Math.max(max, Number(row.id)), 0)
      const addedTodos = [...stationSet.entries()].map(([stationNo, unit]) => {
        todoSeq += 1
        return stationhouseTodoRow({
          id: todoSeq,
          stationNo,
          river: draft.river,
          batchNo: '',
          unit,
          plannedDate: request.plannedDate,
        })
      })

      const batchId = before.seq + 1
      const batchNo = `RT${new Date().getFullYear()}-${String(batchId).padStart(3, '0')}`
      addedTodos.forEach((todo) => {
        todo.维护内容 = `配合复测批次${batchNo}（${draft.river}）安排断面复测外业配合事项`
      })

      const batch: RetestBatch = {
        id: batchId,
        batchNo,
        river: draft.river,
        units: draft.units,
        stationCount: stationSet.size,
        plannedDate: request.plannedDate,
        createdBy: request.operator,
        status: '进行中',
        idemKey: request.idemKey,
        statsRule: before.rule,
        checklistIds: draft.checklist.map((row) => row.crossId),
        items,
        stationTodos: addedTodos.map((todo) => ({
          stationNo: String(todo.站点编号),
          stationhouseId: Number(todo.id),
          recordNo: String(todo.记录编号),
        })),
        summary: { total: items.length, pending: items.length, finished: 0, failed: 0, passed: 0, pendingCheck: 0 },
        createdAt: now(),
        archivedAt: '',
      }

      // 复测批次 + 断面 + 站房待办在同一次本地事务里落库。
      saveRowsBatch({
        [CROSS_KEY]: nextCross,
        [STATIONHOUSE_KEY]: [...stationRows, ...addedTodos],
      })
      saveState({
        seq: batchId,
        rule: before.rule,
        batches: [...before.batches, batch],
      })
      return {
        ok: true,
        message: `复测批次 ${batchNo} 已落库，含 ${items.length} 个断面、${addedTodos.length} 条站房配合待办`,
        duplicated: false,
        batch,
      }
    } finally {
      releaseLock(holder)
    }
  }

  return {
    ok: false,
    message: '断面已被另一终端安排进进行中的复测批次，请刷新后重选',
    duplicated: false,
    batch: null,
  }
}

// ---------- 复测台逐条执行：部分失败不回滚 ----------

function mutateItem(
  batchId: number,
  itemId: string,
  fn: (item: RetestItem) => RetestItem,
): { batch: RetestBatch | null; item: RetestItem | null } {
  const state = loadState()
  const batch = state.batches.find((candidate) => candidate.id === batchId)
  if (!batch) {
    return { batch: null, item: null }
  }
  const index = batch.items.findIndex((item) => item.id === itemId)
  if (index < 0) {
    return { batch, item: null }
  }
  const item = fn(batch.items[index])
  batch.items[index] = item
  refreshSummaries([batch], state.rule)
  saveState(state)
  return { batch, item }
}

function updateCrossRow(crossId: number, status: string): void {
  const rows = listRows(CROSS_KEY)
  const next = rows.map((row) =>
    Number(row.id) === crossId ? { ...row, status, pending: status !== '已校核', abnormal: false } : row,
  )
  saveRowsBatch({ [CROSS_KEY]: next })
}

/** 对单个断面执行复测：fail=true 表示外业失败（设备/天气/水位不达标），留在未完成处可继续。 */
export function executeRetest(
  batchId: number,
  itemId: string,
  fail: boolean,
  reason = '',
): ActionResult {
  const state = loadState()
  const batch = state.batches.find((candidate) => candidate.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到该复测批次' }
  }
  if (batch.status === '已归档') {
    return { ok: false, message: '批次已归档，结果冻结，不能再复测' }
  }
  const item = batch.items.find((candidate) => candidate.id === itemId)
  if (!item) {
    return { ok: false, message: '批次内没有该断面任务' }
  }
  if (item.status === '校核通过') {
    return { ok: false, message: '该断面已校核通过，不需要再复测' }
  }
  // 逐条独立落库：本条失败/成功都不回滚批次里其他断面已完成的结果。
  const nextStatus: RetestItemStatus = fail ? '复测失败' : '复测完成-待校核'
  mutateItem(batchId, itemId, (current) => ({
    ...current,
    status: nextStatus,
    failReason: fail ? reason || '外业复测未通过' : '',
    attempts: current.attempts + 1,
    updatedAt: now(),
  }))
  updateCrossRow(item.crossId, fail ? '需重测' : '待校核')
  return fail
    ? { ok: true, message: `断面「${item.section}」复测失败，保留在未完成处，可随时继续，其他断面结果不受影响` }
    : { ok: true, message: `断面「${item.section}」复测完成，已回到待校核清单` }
}

/** 复测失败的断面从断点处继续：只处理仍未完成（待复测 / 复测失败）的断面。 */
export function continueBatch(
  batchId: number,
  fail: boolean,
  reason = '',
): ActionResult & { finished: number; failed: number } {
  const state = loadState()
  const batch = state.batches.find((candidate) => candidate.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到该复测批次', finished: 0, failed: 0 }
  }
  if (batch.status === '已归档') {
    return { ok: false, message: '批次已归档，不能继续复测', finished: 0, failed: 0 }
  }
  const pendingItems = batch.items.filter(
    (item) => item.status === '待复测' || item.status === '复测失败',
  )
  if (pendingItems.length === 0) {
    return { ok: false, message: '批次内已没有未完成断面', finished: 0, failed: 0 }
  }
  let finished = 0
  let failedCount = 0
  for (const item of pendingItems) {
    const result = executeRetest(batchId, item.id, fail, reason)
    if (!result.ok) {
      break
    }
    if (fail) {
      failedCount += 1
    } else {
      finished += 1
    }
  }
  return {
    ok: true,
    message: fail
      ? `已对 ${failedCount} 个未完成断面复测，均失败并保留在断点处，已完成结果未回滚`
      : `已从断点继续完成 ${finished} 个断面复测，结果不回滚`,
    finished,
    failed: failedCount,
  }
}

/** 校核通过：复测产出的断面在清单上确认校核后转已校核。 */
export function approveRetestItem(batchId: number, itemId: string): ActionResult {
  const state = loadState()
  const batch = state.batches.find((candidate) => candidate.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到该复测批次' }
  }
  if (batch.status === '已归档') {
    return { ok: false, message: '批次已归档，不能再校核' }
  }
  const item = batch.items.find((candidate) => candidate.id === itemId)
  if (!item) {
    return { ok: false, message: '批次内没有该断面任务' }
  }
  if (item.status !== '复测完成-待校核') {
    return { ok: false, message: '只有复测完成待校核的断面才能确认校核' }
  }
  mutateItem(batchId, itemId, (current) => ({
    ...current,
    status: '校核通过',
    updatedAt: now(),
  }))
  updateCrossRow(item.crossId, '已校核')
  return { ok: true, message: `断面「${item.section}」校核通过` }
}

/** 归档：未完成断面清零后可归档，归档时按当前口径冻结摘要；之后规则调整不再重算。 */
export function archiveBatch(batchId: number): ActionResult {
  const state = loadState()
  const batch = state.batches.find((candidate) => candidate.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到该复测批次' }
  }
  if (batch.status === '已归档') {
    return { ok: false, message: '批次已归档，无需重复操作' }
  }
  const unfinished = batch.items.filter(
    (item) => item.status === '待复测' || item.status === '复测失败',
  ).length
  if (unfinished > 0) {
    return { ok: false, message: `还有 ${unfinished} 个断面未完成复测，不能归档（其他结果已保留）` }
  }
  batch.status = '已归档'
  batch.archivedAt = now()
  // 归档瞬间按当前口径算一次并随批次冻结。
  batch.summary = computeSummary(batch, state.rule)
  batch.statsRule = state.rule
  saveState(state)
  return { ok: true, message: `批次 ${batch.batchNo} 已归档，复测摘要已冻结` }
}

// ---------- 查询 ----------

export function listBatches(): RetestBatch[] {
  return loadState().batches
}

export function getBatch(batchId: number): RetestBatch | null {
  return loadState().batches.find((batch) => batch.id === batchId) ?? null
}

export function activeBatchForRiver(river: string): RetestBatch | null {
  return loadState().batches.find((batch) => batch.status === '进行中' && batch.river === river) ?? null
}

/** 断面测量页顶部复测摘要：进行中批次 + 最近一条批次，落库返回/路由返回后都还在。 */
export function retestOverview(): {
  rule: StatsRule
  active: RetestBatch[]
  latest: RetestBatch | null
  checklistOpen: number
} {
  const state = loadState()
  const active = state.batches.filter((batch) => batch.status === '进行中')
  const latest = [...state.batches].sort((a, b) => b.id - a.id)[0] ?? null
  const checklistOpen = state.batches
    .filter((batch) => batch.status !== '已归档')
    .reduce((sum, batch) => sum + batch.summary.pendingCheck, 0)
  return { rule: state.rule, active, latest, checklistOpen }
}

/** 校核清单明细：把批次保存的 checklistIds 解析回当前断面行，已被其他流程改状态的也如实反映。 */
export function resolveChecklist(batch: RetestBatch): ChecklistPreviewRow[] {
  const rows = crossRows()
  return batch.checklistIds
    .map((crossId) => rows.find((row) => Number(row.id) === crossId))
    .filter((row): row is EntryRow => Boolean(row))
    .map((row) => {
      const item = batch.items.find((candidate) => candidate.crossId === Number(row.id))
      return {
        crossId: Number(row.id),
        recordNo: field(row, '记录编号'),
        stationNo: field(row, '站点编号'),
        section: field(row, '断面名称'),
        unit: field(row, '管理单位'),
        status: String(row.status),
        source: item ? '本次重测' : '历史待校核',
      }
    })
}

/** 站房配合待办数：批次落库时在其他入口（站房维护页）一并新增，这里给统计卡片用。 */
export function countCoordinationTodos(rows: EntryRow[]): { open: number; total: number } {
  const todos = rows.filter((row) => field(row, '维护类型') === '复测配合')
  return {
    total: todos.length,
    open: todos.filter((row) => String(row.status) !== '已验收' && String(row.status) !== '已完成').length,
  }
}
