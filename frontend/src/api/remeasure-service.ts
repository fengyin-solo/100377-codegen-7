import { listRows, mutateRows } from '@/data/local-store'
import {
  mutateRemeasureBatches,
  mutateRemeasureStatsRule,
  readRemeasureBatches,
  readRemeasureStatsRule,
} from '@/data/remeasure-store'
import type {
  EntryRow,
  RemeasureBatch,
  RemeasureBatchStatus,
  RemeasureItem,
  RemeasureResult,
  RemeasureStatsRule,
  RemeasureSummary,
} from '@/data/types'

// 编组约定（本复测台的既定规则）：同一批次只允许同一河流、同一管理单位的断面，
// 组内不混合管理单位，便于统一安排外业与明确校核责任；
// 已有「待校核」「需重测」记录可以直接编组，复测批次不影响其既有流转。
export const REMEASURE_ELIGIBLE_STATUSES = ['已测量', '待校核', '需重测']

const UNKNOWN_RIVER = '未登记河流'
const UNKNOWN_UNIT = '未登记单位'

// 老数据可能没有「所在河流」「管理单位」字段：先取记录自身字段，
// 再按站点编号回退到站点登记信息，最后落到未登记，保证已有记录兼容可用。
export function resolveRiver(row: EntryRow): string {
  const direct = String(row['所在河流'] ?? '').trim()
  if (direct) {
    return direct
  }
  const station = listRows('station').find(
    (item) => String(item['站点编号']) === String(row['站点编号']),
  )
  const river = String(station?.['所在河流'] ?? '').trim()
  return river || UNKNOWN_RIVER
}

export function resolveUnit(row: EntryRow): string {
  const direct = String(row['管理单位'] ?? '').trim()
  if (direct) {
    return direct
  }
  const station = listRows('station').find(
    (item) => String(item['站点编号']) === String(row['站点编号']),
  )
  const unit = String(station?.['管理单位'] ?? '').trim()
  return unit || UNKNOWN_UNIT
}

export type RemeasureCandidate = {
  row: EntryRow
  river: string
  unit: string
}

export function listRemeasureCandidates(): RemeasureCandidate[] {
  return listRows('crosssection')
    .filter((row) => REMEASURE_ELIGIBLE_STATUSES.includes(String(row.status)))
    .map((row) => ({ row, river: resolveRiver(row), unit: resolveUnit(row) }))
}

export function listRemeasureBatches(): RemeasureBatch[] {
  return readRemeasureBatches()
}

export function loadRemeasureStatsRule(): RemeasureStatsRule {
  return readRemeasureStatsRule()
}

export function formatRemeasureSummary(summary: RemeasureSummary): string {
  const rate = (summary.completionRate * 100).toFixed(1)
  return `共 ${summary.total} 断面，成功 ${summary.succeeded}、失败 ${summary.failed}、待执行 ${summary.pending}，完成率 ${rate}%（规则 v${summary.ruleVersion}）`
}

function computeSummary(
  items: RemeasureItem[],
  rule: RemeasureStatsRule,
  checklist: string[],
): RemeasureSummary {
  const total = items.length
  const succeeded = items.filter((item) => item.state === '复测成功').length
  const failed = items.filter((item) => item.state === '复测失败').length
  const pending = total - succeeded - failed
  const done = rule.mode === 'success' ? succeeded : succeeded + failed
  return {
    total,
    succeeded,
    failed,
    pending,
    completionRate: total === 0 ? 0 : done / total,
    ruleVersion: rule.version,
    checklist: [...checklist],
  }
}

function deriveStatus(items: RemeasureItem[]): RemeasureBatchStatus {
  if (items.every((item) => item.state === '复测成功')) {
    return '已完成'
  }
  if (items.some((item) => item.state === '复测失败')) {
    return '部分失败'
  }
  if (items.some((item) => item.state === '复测成功')) {
    return '执行中'
  }
  return '待执行'
}

// 幂等键：同一河流 + 同一组断面记录视为同一次提交，两终端并发提交只生效一次。
function idempotencyKeyOf(river: string, recordIds: number[]): string {
  return `${river}#${[...recordIds].sort((a, b) => a - b).join(',')}`
}

// 校核清单：选中断面逐条生成校核事项，同时把同河流既有「待校核」记录一并纳入，
// 保证功能上线前已存在的待校核记录也能随批次校核，不需要重新登记。
function buildChecklist(batchNo: string, selected: EntryRow[], river: string): string[] {
  const items = selected.map(
    (row) => `「${row['记录编号']}」${row['断面名称']}：复测外业完成后提交校核`,
  )
  const selectedIds = new Set(selected.map((row) => Number(row.id)))
  const inherited = listRows('crosssection')
    .filter(
      (row) =>
        String(row.status) === '待校核' &&
        !selectedIds.has(Number(row.id)) &&
        resolveRiver(row) === river,
    )
    .map((row) => `「${row['记录编号']}」${row['断面名称']}：既有待校核记录，随批次 ${batchNo} 一并校核`)
  return [...items, ...inherited]
}

export function createRemeasureBatch(recordIds: number[]): RemeasureResult {
  const uniqueIds = [...new Set(recordIds.map(Number))]
  if (uniqueIds.length < 2) {
    return { ok: false, message: '成组复测至少选择 2 条断面记录' }
  }
  const rows = listRows('crosssection')
  const selected: EntryRow[] = []
  for (const id of uniqueIds) {
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) {
      return { ok: false, message: '存在已删除的断面记录，请刷新后重选' }
    }
    selected.push(row)
  }
  const ineligible = selected.filter(
    (row) => !REMEASURE_ELIGIBLE_STATUSES.includes(String(row.status)),
  )
  if (ineligible.length > 0) {
    const codes = ineligible.map((row) => row['记录编号']).join('、')
    return { ok: false, message: `记录 ${codes} 已校核，无需安排复测` }
  }
  const rivers = new Set(selected.map(resolveRiver))
  if (rivers.size > 1) {
    return { ok: false, message: `成组复测只支持同一河流的断面，当前选择涉及：${[...rivers].join('、')}` }
  }
  const units = new Set(selected.map(resolveUnit))
  if (units.size > 1) {
    return { ok: false, message: `本复测台不允许混合管理单位编组，当前选择涉及：${[...units].join('、')}，请按单位分批` }
  }
  const river = [...rivers][0]
  const unit = [...units][0]
  const key = idempotencyKeyOf(river, uniqueIds)

  // 幂等校验与批次落库在同一个同步变更里完成，两终端并发提交只生效一次。
  const created = mutateRemeasureBatches<RemeasureResult>((batches) => {
    const existing = batches.find((batch) => !batch.archived && batch.idempotencyKey === key)
    if (existing) {
      return {
        batches,
        result: {
          ok: true,
          duplicated: true,
          batch: existing,
          message: `相同断面的复测批次 ${existing.batchNo} 已存在，本次提交未重复生效`,
        },
      }
    }
    const id = batches.reduce((max, batch) => Math.max(max, batch.id), 0) + 1
    const batchNo = `REME-${String(id).padStart(4, '0')}`
    const items: RemeasureItem[] = selected.map((row) => ({
      recordId: Number(row.id),
      记录编号: String(row['记录编号']),
      断面名称: String(row['断面名称']),
      站点编号: String(row['站点编号']),
      state: '待执行',
      note: '',
    }))
    const checklist = buildChecklist(batchNo, selected, river)
    const batch: RemeasureBatch = {
      id,
      batchNo,
      river,
      unit,
      recordIds: uniqueIds,
      items,
      status: '待执行',
      archived: false,
      summary: computeSummary(items, readRemeasureStatsRule(), checklist),
      idempotencyKey: key,
      createdAt: new Date().toISOString().slice(0, 10),
    }
    return {
      batches: [...batches, batch],
      result: { ok: true, batch, message: `复测批次 ${batchNo} 已落库：${formatRemeasureSummary(batch.summary)}` },
    }
  })
  if (created.duplicated || !created.batch) {
    return created
  }
  const batch = created.batch

  // 统一安排重测：选中的断面记录流转为「需重测」。
  mutateRows('crosssection', (current) =>
    current.map((row) =>
      uniqueIds.includes(Number(row.id))
        ? { ...row, status: '需重测', pending: true, abnormal: false }
        : row,
    ),
  )

  // 站房待办：按站点为其他入口（站房维护模块）生成配合事项。
  const stationCodes = [...new Set(selected.map((row) => String(row['站点编号'])))]
  mutateRows('stationhouse', (current) => {
    let nextId = current.reduce((max, row) => Math.max(max, Number(row.id)), 0)
    const today = new Date().toISOString().slice(0, 10)
    const additions = stationCodes.map((stationCode) => {
      nextId += 1
      const names = selected
        .filter((row) => String(row['站点编号']) === stationCode)
        .map((row) => String(row['断面名称']))
        .join('、')
      return {
        id: nextId,
        status: '待安排',
        pending: true,
        abnormal: false,
        记录编号: `STAT-${String(nextId).padStart(4, '0')}`,
        站点编号: stationCode,
        维护类型: '配合事项',
        维护内容: `配合断面复测批次 ${batch.batchNo}（${river}）：${names}`,
        维护单位: unit,
        维护日期: today,
        费用支出: 0,
        维护状态: '待安排',
      } as EntryRow
    })
    return [...current, ...additions]
  })

  // 批次已落库，返回结果仍携带复测摘要，调用方无需再查一次。
  return {
    ok: true,
    batch,
    message: `${created.message}；校核清单 ${batch.summary.checklist.length} 条，站房配合事项 ${stationCodes.length} 项已一并生成`,
  }
}

// 执行（或继续执行）批次：从未完成的断面开始逐项处理，已成功的结果不回滚；
// 部分断面失败时批次停在断点，再次执行从失败处继续。
export function executeRemeasureBatch(
  batchId: number,
  options: { simulateFailure?: boolean } = {},
): RemeasureResult {
  const succeededIds: number[] = []
  const outcome = mutateRemeasureBatches<RemeasureResult>((batches) => {
    const index = batches.findIndex((batch) => batch.id === batchId)
    if (index < 0) {
      return { batches, result: { ok: false, message: `没有找到编号为 ${batchId} 的复测批次` } }
    }
    const batch = batches[index]
    if (batch.archived) {
      return { batches, result: { ok: false, message: `批次 ${batch.batchNo} 已归档，不能再执行` } }
    }
    if (batch.status === '已完成') {
      return { batches, result: { ok: false, message: `批次 ${batch.batchNo} 已完成，无需重复执行` } }
    }
    const items = batch.items.map((item) => ({ ...item }))
    let stopped = false
    for (const item of items) {
      if (item.state === '复测成功') {
        continue
      }
      if (stopped) {
        break
      }
      if (options.simulateFailure) {
        item.state = '复测失败'
        item.note = '复测中断，待继续执行'
        stopped = true
        continue
      }
      item.state = '复测成功'
      item.note = ''
      succeededIds.push(item.recordId)
    }
    const updated: RemeasureBatch = {
      ...batch,
      items,
      status: deriveStatus(items),
      summary: computeSummary(items, readRemeasureStatsRule(), batch.summary.checklist),
    }
    const next = [...batches]
    next[index] = updated
    const message =
      updated.status === '已完成'
        ? `批次 ${updated.batchNo} 复测完成：${formatRemeasureSummary(updated.summary)}`
        : `批次 ${updated.batchNo} 部分断面未完成，可从断点继续：${formatRemeasureSummary(updated.summary)}`
    return { batches: next, result: { ok: true, message, batch: updated } }
  })
  if (!outcome.ok || succeededIds.length === 0) {
    return outcome
  }
  // 只有复测成功的断面记录流转为「待校核」，失败与未执行的保持原状，不回滚。
  mutateRows('crosssection', (current) =>
    current.map((row) =>
      succeededIds.includes(Number(row.id))
        ? { ...row, status: '待校核', pending: true, abnormal: false }
        : row,
    ),
  )
  return outcome
}

export function archiveRemeasureBatch(batchId: number): RemeasureResult {
  return mutateRemeasureBatches<RemeasureResult>((batches) => {
    const index = batches.findIndex((batch) => batch.id === batchId)
    if (index < 0) {
      return { batches, result: { ok: false, message: `没有找到编号为 ${batchId} 的复测批次` } }
    }
    const batch = batches[index]
    if (batch.archived) {
      return { batches, result: { ok: false, message: `批次 ${batch.batchNo} 已归档，不用重复操作` } }
    }
    if (batch.status !== '已完成') {
      return { batches, result: { ok: false, message: `批次 ${batch.batchNo} 尚未完成，不能归档` } }
    }
    const updated: RemeasureBatch = { ...batch, archived: true }
    const next = [...batches]
    next[index] = updated
    return {
      batches: next,
      result: { ok: true, message: `批次 ${batch.batchNo} 已归档，归档后不再参与统计规则重算`, batch: updated },
    }
  })
}

// 调整统计规则：口径在「成功数 / 已处理数」之间切换并递增版本，
// 所有未归档批次的复测摘要按新规则重算，已归档批次保持原样。
export function adjustRemeasureStatsRule(): {
  ok: boolean
  message: string
  rule: RemeasureStatsRule
} {
  const rule = mutateRemeasureStatsRule((current) => {
    const next: RemeasureStatsRule =
      current.mode === 'success'
        ? { version: current.version + 1, mode: 'processed', label: '按已处理断面（成功+失败）计完成率' }
        : { version: current.version + 1, mode: 'success', label: '按复测成功数计完成率' }
    return { rule: next, result: next }
  })
  const recalculated = mutateRemeasureBatches((batches) => {
    let count = 0
    const next = batches.map((batch) => {
      if (batch.archived) {
        return batch
      }
      count += 1
      return { ...batch, summary: computeSummary(batch.items, rule, batch.summary.checklist) }
    })
    return { batches: next, result: count }
  })
  return {
    ok: true,
    message: `统计规则已调整为 v${rule.version}（${rule.label}），已重算 ${recalculated} 个未归档批次`,
    rule,
  }
}
