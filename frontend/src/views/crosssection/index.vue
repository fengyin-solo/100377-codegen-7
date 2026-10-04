<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">同一河流的断面可多选成组安排复测，自动生成校核清单；历史待校核记录一并兼容。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记断面测量记录</button>
        <button class="btn" type="button" :class="{ primary: showWorkbench }" @click="showWorkbench = !showWorkbench">
          成组复测台（{{ overview.active.length }} 个进行中批次）
        </button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 复测摘要：批次落库后刷新页面、从其他路由返回都保留 -->
    <section v-if="overview.latest" class="retest-banner">
      <div class="banner-head">
        <strong>复测摘要</strong>
        <span v-if="overview.latest.status === '已归档'" class="tag tag-archive">已归档·快照冻结</span>
        <span class="tag">{{ ruleLabel(overview.rule) }}</span>
      </div>
      <p class="banner-line">
        最近批次 {{ overview.latest.batchNo }}（{{ overview.latest.river }}，
        {{ overview.latest.units.join('、') }}，{{ overview.latest.stationCount }} 个站）：
        共 {{ overview.latest.summary.total }}，复测完成待校核
        <b>{{ overview.latest.summary.finished }}</b>，校核通过
        <b>{{ overview.latest.summary.passed }}</b>，失败待继续
        <b>{{ overview.latest.summary.failed }}</b>，清单待校核
        <b>{{ overview.latest.summary.pendingCheck }}</b>
        ｜全部未归档批次清单待校核合计 <b>{{ overview.checklistOpen }}</b>
      </p>
      <div class="rule-switch">
        <span>统计口径：</span>
        <label class="rule-opt">
          <input type="radio" value="narrow" :checked="overview.rule === 'narrow'" @change="switchRule('narrow')" />
          窄口径（仅本次重测）
        </label>
        <label class="rule-opt">
          <input type="radio" value="wide" :checked="overview.rule === 'wide'" @change="switchRule('wide')" />
          宽口径（校核清单，含同河历史待校核）
        </label>
      </div>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="bulk-bar">
      <span>已勾选 <b>{{ selectedIds.length }}</b> 个断面</span>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="openRetest">
        成组安排复测
      </button>
      <span class="bulk-hint">仅可多选「已测量 / 待校核 / 需重测」断面，且必须同属一条河流；允许跨管理单位混编</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th style="width: 40px">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="isSelected(row)"
              :disabled="!selectable(row)"
              @change="toggleSelect(row)"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无断面测量数据，可先登记断面测量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条断面测量记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 成组复测台：批次、复测执行、校核清单 -->
    <section v-if="showWorkbench" class="workbench">
      <div class="workbench-head">
        <h3>成组复测台</h3>
        <span class="bulk-hint">部分断面复测失败时从未完成处继续，其他断面结果不回滚</span>
      </div>
      <p v-if="!allBatches.length" class="empty-state">暂无复测批次，在上方表格勾选同一河流的断面后安排</p>
      <article v-for="batch in allBatches" :key="batch.id" class="batch-card" :class="{ archived: batch.status === '已归档' }">
        <header class="batch-head">
          <div>
            <strong>{{ batch.batchNo }}</strong>
            <span class="tag">{{ batch.river }}</span>
            <span v-if="batch.status === '已归档'" class="tag tag-archive">已归档</span>
            <span class="tag">{{ ruleLabel(batch.statsRule) }}</span>
            <span class="bulk-hint">计划日期 {{ batch.plannedDate }} · 创建人 {{ batch.createdBy }}</span>
          </div>
          <div class="row-actions">
            <button class="link" type="button" @click="batch.expanded = !batch.expanded">
              {{ batch.expanded ? '收起明细' : '展开明细/校核清单' }}
            </button>
            <button
              v-if="batch.status !== '已归档'"
              class="link"
              type="button"
              @click="archive(batch)"
            >归档批次</button>
          </div>
        </header>
        <p class="batch-units">涉及管理单位：{{ batch.units.join('、') }}（允许跨单位混编，按单位分列校核责任）</p>
        <div class="batch-summary">
          <span>断面总数 {{ batch.summary.total }}</span>
          <span>待复测 {{ batch.summary.pending }}</span>
          <span>复测完成待校核 {{ batch.summary.finished }}</span>
          <span class="error-text">复测失败 {{ batch.summary.failed }}</span>
          <span>校核通过 {{ batch.summary.passed }}</span>
          <span class="hl">清单待校核 {{ batch.summary.pendingCheck }}</span>
        </div>
        <div v-if="batch.status !== '已归档'" class="batch-actions">
          <button class="btn" type="button" @click="continueBatch(batch, false)">从未完成处继续（全部复测通过）</button>
          <button class="btn" type="button" @click="continueBatch(batch, true)">模拟本批未完成项复测失败（保留断点）</button>
        </div>

        <div v-if="batch.expanded" class="batch-detail">
          <table class="data-table inner">
            <thead>
              <tr><th>断面</th><th>站点</th><th>管理单位</th><th>来源</th><th>任务状态</th><th>尝试次数</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in batch.items" :key="item.id">
                <td>{{ item.section }}</td>
                <td>{{ item.stationNo }}</td>
                <td>{{ item.unit }}</td>
                <td>{{ item.preexistingPending ? '历史待校核' : '本次重测' }}</td>
                <td>{{ item.status }}<span v-if="item.failReason" class="error-text">（{{ item.failReason }}）</span></td>
                <td>{{ item.attempts }}</td>
                <td class="row-actions">
                  <template v-if="batch.status !== '已归档' && item.status !== '校核通过'">
                    <button class="link" type="button" @click="execute(batch, item, false)">复测通过</button>
                    <button class="link" type="button" @click="execute(batch, item, true)">复测失败</button>
                    <button
                      v-if="item.status === '复测完成-待校核'"
                      class="link"
                      type="button"
                      @click="approve(batch, item)"
                    >校核通过</button>
                  </template>
                  <span v-else-if="item.status === '校核通过'">已闭环</span>
                  <span v-else>批次已冻结</span>
                </td>
              </tr>
            </tbody>
          </table>

          <h4>校核清单（含同河历史待校核，按单位分列）</h4>
          <table class="data-table inner">
            <thead>
              <tr><th>记录编号</th><th>断面</th><th>站点</th><th>管理单位</th><th>清单来源</th><th>当前断面状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="line in checklists[batch.id] ?? []" :key="line.crossId">
                <td>{{ line.recordNo }}</td>
                <td>{{ line.section }}</td>
                <td>{{ line.stationNo }}</td>
                <td>{{ line.unit }}</td>
                <td>{{ line.source }}</td>
                <td>{{ line.status }}</td>
              </tr>
            </tbody>
          </table>

          <h4>已联动新增的站房配合待办</h4>
          <ul class="todo-list">
            <li v-for="todo in batch.stationTodos" :key="todo.stationhouseId">
              {{ todo.recordNo }} · 站点 {{ todo.stationNo }} · 可在「站房维护」页安排
            </li>
          </ul>
        </div>
      </article>
    </section>

    <!-- 安排复测对话框 -->
    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>成组安排复测</h3>
        <p v-if="!dialog.draft?.ok" class="error-text">{{ dialog.draft?.message || '正在生成校核清单预览…' }}</p>
        <template v-else>
          <p class="batch-units">
            河流：<b>{{ dialog.draft.river }}</b>；
            涉及管理单位：<b>{{ dialog.draft.units.join('、') }}</b>
            <span class="bulk-hint">（允许同河跨单位混编）</span>
          </p>
          <label class="filter-item">
            <span>计划复测日期</span>
            <input v-model="dialog.plannedDate" type="date" />
          </label>
          <h4>校核清单预览（{{ dialog.draft.checklist.length }} 项）</h4>
          <div class="checklist-preview">
            <table class="data-table inner">
              <thead>
                <tr><th>记录编号</th><th>断面</th><th>管理单位</th><th>当前状态</th><th>来源</th></tr>
              </thead>
              <tbody>
                <tr v-for="line in dialog.draft.checklist" :key="line.crossId">
                  <td>{{ line.recordNo }}</td>
                  <td>{{ line.section }}</td>
                  <td>{{ line.unit }}</td>
                  <td>{{ line.status }}</td>
                  <td>{{ line.source }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="bulk-hint">提交后：断面统一置「需重测」，并为涉及站房在站房维护模块新增复测配合待办。</p>
          <p v-if="dialog.message" :class="dialog.submitOk ? 'ok-text' : 'error-text'">{{ dialog.message }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" :disabled="dialog.submitting" @click="closeDialog">取消</button>
            <button class="btn" type="button" :disabled="dialog.submitting" @click="simulateConcurrent">
              模拟双终端并发提交（只应生效一次）
            </button>
            <button class="btn primary" type="button" :disabled="dialog.submitting" @click="submitBatch">
              {{ dialog.submitting ? '提交中…' : '确认安排复测' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  approveRetestItem,
  archiveBatch as archiveBatchApi,
  buildRetestDraft,
  continueBatch as continueBatchApi,
  executeRetest,
  listBatches,
  makeIdemKey,
  resolveChecklist,
  retestOverview,
  submitRetestBatch,
  subscribeStorage,
  updateStatsRule,
} from '@/api/retest-service'
import type {
  ActionResult,
  EntryRow,
  RetestBatch,
  RetestDraft,
  RetestItem,
  StatsRule,
} from '@/data/types'

const meta = moduleMeta('crosssection')
const columns = ["记录编号", "站点编号", "断面名称", "所在河流", "管理单位", "测量方法", "起点距", "河底高程", "测量日期", "记录状态"]
const actions = ["提交校核", "确认校核", "安排重测"]
const statuses = ["已测量", "待校核", "已校核", "需重测"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["记录编号", "站点编号", "断面名称", "所在河流"]
const showWorkbench = ref(false)
const selectedIds = ref<number[]>([])
const overview = ref(retestOverview())
const allBatches = ref<(RetestBatch & { expanded?: boolean })[]>([])
const checklists = reactive<Record<number, ReturnType<typeof resolveChecklist>>>({})

const dialog = reactive<{
  open: boolean
  submitting: boolean
  plannedDate: string
  crossIds: number[]
  draft: RetestDraft | null
  message: string
  submitOk: boolean
}>({
  open: false,
  submitting: false,
  plannedDate: new Date().toISOString().slice(0, 10),
  crossIds: [],
  draft: null,
  message: '',
  submitOk: false,
})

const stats = computed(() => {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const active = overview.value.active.length
  return [
    { label: "本月测量次数", value: rows.value.filter((row) => String(row["测量日期"] ?? '').startsWith(currentMonth)).length },
    { label: "待校核记录", value: rows.value.filter((row) => String(row.status) === "待校核").length },
    { label: "需重测记录", value: rows.value.filter((row) => String(row.status) === "需重测").length },
    { label: "复测中批次", value: active },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function ruleLabel(rule: StatsRule): string {
  return rule === 'wide' ? '宽口径' : '窄口径'
}

const SELECTABLE = ["已测量", "待校核", "需重测"]
function selectable(row: EntryRow): boolean {
  return SELECTABLE.includes(String(row.status))
}

function isSelected(row: EntryRow): boolean {
  return selectedIds.value.includes(Number(row.id))
}

function toggleSelect(row: EntryRow): void {
  const id = Number(row.id)
  if (isSelected(row)) {
    selectedIds.value = selectedIds.value.filter((value) => value !== id)
    return
  }
  selectedIds.value = [...selectedIds.value, id]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '断面测量记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openRetest(): void {
  const draft = buildRetestDraft(selectedIds.value)
  dialog.open = true
  dialog.draft = draft
  dialog.crossIds = selectedIds.value
  dialog.message = draft.ok ? '' : draft.message
  dialog.submitOk = false
}

function closeDialog(): void {
  dialog.open = false
  dialog.submitting = false
}

async function submitBatch(): Promise<ActionResult | undefined> {
  if (!dialog.draft?.ok) {
    dialog.message = dialog.draft?.message ?? '校核清单不可用'
    dialog.submitOk = false
    return undefined
  }
  dialog.submitting = true
  dialog.message = ''
  const idemKey = makeIdemKey(dialog.draft.river, dialog.crossIds, dialog.plannedDate)
  const result = await submitRetestBatch({
    idemKey,
    river: dialog.draft.river,
    crossIds: dialog.crossIds,
    plannedDate: dialog.plannedDate,
    operator: '值班管理员',
  })
  dialog.submitting = false
  dialog.submitOk = result.ok
  dialog.message = result.message
  if (result.ok) {
    selectedIds.value = []
    reload()
    window.setTimeout(() => {
      dialog.open = false
      showWorkbench.value = true
    }, 700)
  }
  return result
}

async function simulateConcurrent(): Promise<void> {
  // 两个「终端」用同一组断面、同一天、同一计划日期并发提交：期望只落库一个批次。
  dialog.submitting = true
  dialog.message = '双终端并发提交中…'
  if (!dialog.draft?.ok) {
    dialog.submitting = false
    return
  }
  const idemKey = makeIdemKey(dialog.draft.river, dialog.crossIds, dialog.plannedDate)
  const payload = {
    idemKey,
    river: dialog.draft.river,
    crossIds: dialog.crossIds,
    plannedDate: dialog.plannedDate,
    operator: '值班管理员',
  }
  const [first, second] = await Promise.all([
    submitRetestBatch({ ...payload, operator: '终端A' }),
    submitRetestBatch({ ...payload, operator: '终端B' }),
  ])
  dialog.submitting = false
  const accepted = [first, second].filter((result) => result.ok)
  const rejected = [first, second].filter((result) => result.duplicated)
  dialog.submitOk = accepted.length === 1 && rejected.length === 1
  dialog.message = dialog.submitOk
    ? `并发自测通过：终端${first.ok ? 'A' : 'B'}提交生效（${accepted[0].batch?.batchNo}），另一终端被幂等拦截，只生效一次`
    : '并发自测出现异常：应只有一个终端提交成功'
  if (dialog.submitOk) {
    selectedIds.value = []
    reload()
    window.setTimeout(() => {
      dialog.open = false
      showWorkbench.value = true
    }, 1200)
  }
}

function execute(batch: RetestBatch, item: RetestItem, fail: boolean): void {
  const result = executeRetest(batch.id, item.id, fail, fail ? '水位陡变/仪器故障' : '')
  errorMessage.value = result.ok ? '' : result.message
  reloadWorkbench()
}

function continueBatch(batch: RetestBatch, fail: boolean): void {
  const result = continueBatchApi(batch.id, fail, '水情不满足复测条件')
  errorMessage.value = result.ok ? '' : result.message
  reloadWorkbench()
}

function approve(batch: RetestBatch, item: RetestItem): void {
  const result = approveRetestItem(batch.id, item.id)
  errorMessage.value = result.ok ? '' : result.message
  reloadWorkbench()
}

function archive(batch: RetestBatch): void {
  const result = archiveBatchApi(batch.id)
  errorMessage.value = result.ok ? '' : result.message
  reloadWorkbench()
}

function switchRule(rule: StatsRule): void {
  const result = updateStatsRule(rule)
  errorMessage.value = result.ok
    ? `${result.message}（重算 ${result.recomputed} 个未归档批次）`
    : result.message
  reloadWorkbench()
}

function reloadWorkbench(): void {
  const expandedIds = new Set(allBatches.value.filter((batch) => batch.expanded).map((batch) => batch.id))
  allBatches.value = [...listBatches()]
    .sort((a, b) => b.id - a.id)
    .map((batch) => ({ ...batch, expanded: expandedIds.has(batch.id) }))
  for (const batch of allBatches.value) {
    if (batch.expanded) {
      checklists[batch.id] = resolveChecklist(batch)
    } else {
      delete checklists[batch.id]
    }
  }
  overview.value = retestOverview()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    selectedIds.value = selectedIds.value.filter((id) =>
      payload.items.some((row) => Number(row.id) === id && selectable(row)),
    )
    reloadWorkbench()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '断面测量列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  reload()
  // 另一终端提交批次或改了断面状态，本终端自动刷新复测台与清单。
  unsubscribe = subscribeStorage(() => {
    reload()
  })
})
onUnmounted(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #eef4ff;
  border: 1px solid #cdddf7;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
.bulk-hint { color: var(--muted); font-size: 12px; }
.retest-banner {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 12px;
}
.banner-head { display: flex; align-items: center; gap: 8px; }
.banner-line { font-size: 13px; margin: 6px 0; }
.rule-switch { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--muted); }
.rule-opt { display: inline-flex; align-items: center; gap: 4px; }
.tag {
  display: inline-block;
  background: #eef2f7;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  margin-left: 6px;
}
.tag-archive { background: #fde8e8; color: #b42318; }
.hl { color: var(--brand); font-weight: 600; }
.ok-text { color: #067647; }
.workbench { margin-top: 18px; }
.workbench-head { display: flex; align-items: baseline; gap: 12px; }
.batch-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.batch-card.archived { opacity: 0.75; }
.batch-head { display: flex; justify-content: space-between; align-items: center; }
.batch-units { font-size: 13px; margin: 6px 0; }
.batch-summary { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; margin: 8px 0; }
.batch-actions { display: flex; gap: 8px; }
.batch-detail { margin-top: 10px; }
.batch-detail h4 { margin: 12px 0 6px; font-size: 13px; }
.data-table.inner { font-size: 12px; }
.todo-list { font-size: 12px; color: var(--muted); margin: 6px 0; padding-left: 18px; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 720px;
  max-width: 92vw;
  max-height: 86vh;
  overflow: auto;
}
.checklist-preview { max-height: 260px; overflow: auto; margin: 6px 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
</style>
