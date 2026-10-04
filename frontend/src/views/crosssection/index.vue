<template>
  <section class="page" data-module="crosssection">
    <header class="page-head">
      <div>
        <h2>断面测量管理</h2>
        <p class="page-desc">维护断面测量记录，围绕记录编号、站点编号、断面名称、测量方法做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记断面测量记录</button>
        <button class="btn" type="button" @click="exportRows">导出断面测量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无断面测量数据，可先登记断面测量记录</td>
        </tr>
      </tbody>
    </table>

    <section class="remeasure-panel" data-panel="remeasure">
      <header class="panel-head">
        <div>
          <h3>成组复测台</h3>
          <p class="panel-desc">
            多选同一河流的断面记录统一安排重测并生成校核清单；组内不混合管理单位，已有待校核记录可直接编组，随批次一并校核。
          </p>
        </div>
        <div class="panel-rule">
          <span>统计规则 v{{ statsRule.version }}：{{ statsRule.label }}</span>
          <button class="btn" type="button" @click="adjustRule">调整统计规则</button>
        </div>
      </header>

      <div class="panel-block">
        <h4 class="block-title">一、选择复测断面（{{ candidates.length }} 条可编组）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>记录编号</th>
              <th>断面名称</th>
              <th>所在河流</th>
              <th>管理单位</th>
              <th>当前状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in candidates" :key="String(item.row.id)">
              <td>
                <input v-model="selectedIds" type="checkbox" :value="Number(item.row.id)" />
              </td>
              <td>{{ item.row['记录编号'] }}</td>
              <td>{{ item.row['断面名称'] }}</td>
              <td>{{ item.river }}</td>
              <td>{{ item.unit }}</td>
              <td>{{ item.row.status }}</td>
            </tr>
            <tr v-if="!candidates.length">
              <td colspan="6" class="empty-state">暂无可编组的断面记录（已校核记录无需复测）</td>
            </tr>
          </tbody>
        </table>
        <div class="block-actions">
          <button class="btn primary" type="button" @click="createBatch">
            统一安排重测并生成校核清单
          </button>
          <span class="block-hint">已选 {{ selectedIds.length }} 条；同一批次须为同一河流、同一管理单位</span>
        </div>
      </div>

      <div class="panel-block">
        <h4 class="block-title">二、复测批次（{{ batches.length }}）</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>批次号</th>
              <th>所在河流</th>
              <th>管理单位</th>
              <th>断面数</th>
              <th>批次状态</th>
              <th>完成率</th>
              <th>归档</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>{{ batch.batchNo }}</td>
              <td>{{ batch.river }}</td>
              <td>{{ batch.unit }}</td>
              <td>{{ batch.summary.total }}</td>
              <td>{{ batch.status }}</td>
              <td>
                {{ formatRate(batch) }}
                <span class="rule-tag">v{{ batch.summary.ruleVersion }}</span>
              </td>
              <td>{{ batch.archived ? '已归档' : '未归档' }}</td>
              <td class="row-actions">
                <button
                  v-if="!batch.archived && batch.status !== '已完成'"
                  class="link"
                  type="button"
                  @click="executeBatch(batch, false)"
                >
                  {{ batch.status === '待执行' ? '执行复测' : '继续执行' }}
                </button>
                <button
                  v-if="!batch.archived && batch.status !== '已完成'"
                  class="link"
                  type="button"
                  @click="executeBatch(batch, true)"
                >
                  模拟中断
                </button>
                <button
                  v-if="batch.status === '已完成' && !batch.archived"
                  class="link"
                  type="button"
                  @click="archiveBatch(batch)"
                >
                  归档
                </button>
                <button class="link" type="button" @click="toggleChecklist(batch)">校核清单</button>
              </td>
            </tr>
            <tr v-if="!batches.length">
              <td colspan="8" class="empty-state">暂无复测批次，请先在上方编组</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="checklistBatch" class="panel-block">
        <h4 class="block-title">
          校核清单 — {{ checklistBatch.batchNo }}（{{ checklistBatch.summary.checklist.length }} 条）
        </h4>
        <ol class="checklist">
          <li v-for="(entry, index) in checklistBatch.summary.checklist" :key="index">{{ entry }}</li>
        </ol>
        <ul class="item-states">
          <li v-for="item in checklistBatch.items" :key="item.recordId">
            {{ item.记录编号 }} {{ item.断面名称 }} — {{ item.state
            }}<span v-if="item.note">（{{ item.note }}）</span>
          </li>
        </ul>
      </div>

      <p v-if="panelMessage" class="panel-message">{{ panelMessage }}</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条断面测量记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  adjustRemeasureStatsRule,
  archiveRemeasureBatch,
  createRemeasureBatch,
  executeRemeasureBatch,
  listRemeasureBatches,
  listRemeasureCandidates,
  loadRemeasureStatsRule,
  type RemeasureCandidate,
} from '@/api/remeasure-service'
import type { EntryRow, RemeasureBatch, RemeasureStatsRule } from '@/data/types'

const meta = moduleMeta('crosssection')
const columns = ["记录编号", "站点编号", "断面名称", "所在河流", "管理单位", "测量方法", "起点距", "河底高程", "测量日期", "记录状态"]
const actions = ["提交校核", "确认校核", "安排重测"]
const statuses = ["已测量", "待校核", "已校核", "需重测"]
const stats = [{"label": "本月测量次数", "value": 0}, {"label": "待校核记录", "value": 0}, {"label": "需重测记录", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 成组复测台
const candidates = ref<RemeasureCandidate[]>([])
const selectedIds = ref<number[]>([])
const batches = ref<RemeasureBatch[]>([])
const statsRule = ref<RemeasureStatsRule>(loadRemeasureStatsRule())
const checklistBatchId = ref<number | null>(null)
const panelMessage = ref('')
const checklistBatch = computed(
  () => batches.value.find((batch) => batch.id === checklistBatchId.value) ?? null,
)

function formatRate(batch: RemeasureBatch) {
  return `${(batch.summary.completionRate * 100).toFixed(1)}%`
}

function createBatch() {
  const result = createRemeasureBatch(selectedIds.value)
  panelMessage.value = result.message
  if (!result.ok) {
    return
  }
  if (result.batch) {
    checklistBatchId.value = result.batch.id
  }
  if (!result.duplicated) {
    selectedIds.value = []
  }
  reload()
}

function executeBatch(batch: RemeasureBatch, simulateFailure: boolean) {
  const result = executeRemeasureBatch(batch.id, { simulateFailure })
  panelMessage.value = result.message
  reload()
}

function archiveBatch(batch: RemeasureBatch) {
  const result = archiveRemeasureBatch(batch.id)
  panelMessage.value = result.message
  reload()
}

function adjustRule() {
  const result = adjustRemeasureStatsRule()
  statsRule.value = result.rule
  panelMessage.value = result.message
  reload()
}

function toggleChecklist(batch: RemeasureBatch) {
  checklistBatchId.value = checklistBatchId.value === batch.id ? null : batch.id
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    candidates.value = listRemeasureCandidates()
    batches.value = listRemeasureBatches()
    statsRule.value = loadRemeasureStatsRule()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '断面测量列表读取失败'
  }
}

onMounted(reload)
</script>
