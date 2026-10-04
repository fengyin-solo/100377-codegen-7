/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 成组复测台：复测批次、校核清单与统计规则的类型。 */

export type RemeasureItemState = '待执行' | '复测成功' | '复测失败'

export type RemeasureBatchStatus = '待执行' | '执行中' | '部分失败' | '已完成'

export type RemeasureItem = {
  recordId: number
  记录编号: string
  断面名称: string
  站点编号: string
  state: RemeasureItemState
  note: string
}

export type RemeasureSummary = {
  total: number
  succeeded: number
  failed: number
  pending: number
  completionRate: number
  ruleVersion: number
  checklist: string[]
}

export type RemeasureBatch = {
  id: number
  batchNo: string
  river: string
  unit: string
  recordIds: number[]
  items: RemeasureItem[]
  status: RemeasureBatchStatus
  archived: boolean
  summary: RemeasureSummary
  idempotencyKey: string
  createdAt: string
}

export type RemeasureStatsRule = {
  version: number
  mode: 'success' | 'processed'
  label: string
}

export type RemeasureResult = {
  ok: boolean
  message: string
  batch?: RemeasureBatch
  duplicated?: boolean
}
