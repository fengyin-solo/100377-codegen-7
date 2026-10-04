import type { RemeasureBatch, RemeasureStatsRule } from './types'

// 成组复测的批次与统计规则单独落 localStorage，与模块数据分开。
// 所有写操作都包在同步的「读最新 -> 变更 -> 写回」里，中间没有 await：
// 两个终端（标签页）并发提交时，后执行的一方一定能看到先写的一方，配合幂等键只生效一次。
const BATCHES_KEY = 'hydrology-monitor-station:remeasure-batches'
const RULE_KEY = 'hydrology-monitor-station:remeasure-stats-rule'

export const DEFAULT_STATS_RULE: RemeasureStatsRule = {
  version: 1,
  mode: 'success',
  label: '按复测成功数计完成率',
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write<T>(key: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

export function readRemeasureBatches(): RemeasureBatch[] {
  return read<RemeasureBatch[]>(BATCHES_KEY, [])
}

export function readRemeasureStatsRule(): RemeasureStatsRule {
  return read<RemeasureStatsRule>(RULE_KEY, DEFAULT_STATS_RULE)
}

export function mutateRemeasureBatches<T>(
  mutator: (batches: RemeasureBatch[]) => { batches: RemeasureBatch[]; result: T },
): T {
  const { batches, result } = mutator(readRemeasureBatches())
  write(BATCHES_KEY, batches)
  return result
}

export function mutateRemeasureStatsRule<T>(
  mutator: (rule: RemeasureStatsRule) => { rule: RemeasureStatsRule; result: T },
): T {
  const { rule, result } = mutator(readRemeasureStatsRule())
  write(RULE_KEY, rule)
  return result
}
