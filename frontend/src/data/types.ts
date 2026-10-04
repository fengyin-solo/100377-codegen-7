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

/** 成组复测统计口径：窄口径只看本次重测产出，宽口径按整条河的校核清单统计。 */
export type StatsRule = 'narrow' | 'wide'

export type RetestItemStatus = '待复测' | '复测完成-待校核' | '校核通过' | '复测失败'

/** 复测批次里的单个断面任务，逐条落库，失败不影响其他条目。 */
export type RetestItem = {
  id: string
  crossId: number
  recordNo: string
  stationNo: string
  section: string
  unit: string
  /** 安排复测前该断面已是「待校核」的历史记录，用于兼容校核清单。 */
  preexistingPending: boolean
  status: RetestItemStatus
  failReason: string
  attempts: number
  updatedAt: string
}

export type RetestBatch = {
  id: number
  batchNo: string
  river: string
  units: string[]
  stationCount: number
  plannedDate: string
  createdBy: string
  status: '进行中' | '已归档'
  /** 幂等键：同一河流、同一组断面、同一天的重复提交只生效一次。 */
  idemKey: string
  /** 归档时按该口径冻结摘要，之后统计规则调整不再重算。 */
  statsRule: StatsRule
  /** 校核清单快照：本次选中的断面 + 同河历史待校核断面。 */
  checklistIds: number[]
  items: RetestItem[]
  stationTodos: { stationNo: string; stationhouseId: number; recordNo: string }[]
  summary: BatchSummary
  createdAt: string
  archivedAt: string
}

export type BatchSummary = {
  total: number
  pending: number
  finished: number
  failed: number
  passed: number
  pendingCheck: number
}

export type RetestState = {
  seq: number
  rule: StatsRule
  batches: RetestBatch[]
}

export type ChecklistPreviewRow = {
  crossId: number
  recordNo: string
  stationNo: string
  section: string
  unit: string
  status: string
  source: '本次重测' | '历史待校核'
}

export type RetestDraft = {
  ok: boolean
  message: string
  river: string
  units: string[]
  checklist: ChecklistPreviewRow[]
}

export type RetestSubmitRequest = {
  idemKey: string
  river: string
  crossIds: number[]
  plannedDate: string
  operator: string
}

export type RetestSubmitResult = {
  ok: boolean
  message: string
  /** 命中另一终端/重复点击已提交的同一安排，直接返回原批次，不再生成第二份。 */
  duplicated: boolean
  batch: RetestBatch | null
}
