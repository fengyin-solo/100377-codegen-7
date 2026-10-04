<template>
  <section class="page" data-module="stationhouse">
    <header class="page-head">
      <div>
        <h2>站房维护管理</h2>
        <p class="page-desc">维护站房维护记录，围绕记录编号、站点编号、维护类型、维护内容做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记站房维护记录</button>
        <button class="btn" type="button" @click="exportRows">导出站房维护清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="coordOpen" class="coord-note">
      断面成组复测落库时已为本页联动新增 <b>{{ coordOpen }}</b> 条「复测配合」待办（共 {{ coordTotal }} 条），
      与常规站房维护一并安排验收。
    </p>

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
          <th>来源</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'coord-row': isCoordination(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span v-if="isCoordination(row)" class="coord-tag">复测配合</span>
            <span v-else>常规维护</span>
          </td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无站房维护数据，可先登记站房维护记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条站房维护记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { countCoordinationTodos, subscribeStorage } from '@/api/retest-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('stationhouse')
const columns = ["记录编号", "站点编号", "维护类型", "维护内容", "维护单位", "维护日期", "费用支出", "维护状态"]
const actions = ["安排维护", "确认完工", "通过验收"]
const statuses = ["待安排", "已安排", "施工中", "已完成", "已验收"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

function isCoordination(row: EntryRow): boolean {
  return String(row['维护类型'] ?? '') === '复测配合'
}

const coordStats = computed(() => countCoordinationTodos(rows.value))
const coordOpen = computed(() => coordStats.value.open)
const coordTotal = computed(() => coordStats.value.total)

const stats = computed(() => [
  { label: "待维护项数", value: rows.value.filter((row) => String(row.status) === "待安排").length },
  { label: "复测配合待办", value: coordOpen.value },
  { label: "本月已验收", value: rows.value.filter((row) => String(row["维护日期"] ?? '').startsWith(new Date().toISOString().slice(0, 7)) && String(row.status) === "已验收").length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '站房维护记录登记入口尚未接入审批流'
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站房维护列表读取失败'
  }
}

let unsubscribe: (() => void) | null = null
onMounted(() => {
  reload()
  // 断面复测批次在另一终端落库、新增复测配合待办时，本页自动刷新。
  unsubscribe = subscribeStorage(reload)
})
onUnmounted(() => {
  unsubscribe?.()
})
</script>

<style scoped>
.coord-note {
  background: #eef4ff;
  border: 1px solid #cdddf7;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin: 0 0 10px;
}
.coord-row { background: #f7faff; }
.coord-tag {
  display: inline-block;
  background: var(--brand);
  color: #fff;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
}
</style>
