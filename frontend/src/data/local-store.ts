import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 成组复测自己的数据命名空间：批次、统计口径、跨终端互斥锁都在这里。
const RETEST_KEY = 'hydrology-monitor-station:retest'
const LOCK_KEY = 'hydrology-monitor-station:retest-lock'
const LOCK_TTL_MS = 8000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoredState = Record<string, EntryRow[]>

function seedState(): StoredState {
  return clone(SEED_ROWS)
}

function readStorage(): StoredState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredState
    // 新增模块或新字段以种子数据兜底，旧浏览器里已有的改动仍然保留。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoredState | null = null

export function allRows(): StoredState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function persist(state: StoredState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  persist({ ...allRows(), [key]: rows })
}

/**
 * 一次性落库多个业务模块：复测批次要同时改断面测量记录和站房待办，
 * 调用方在一次返回值里拿到全部新行，避免一半写进去一半没写。
 */
export function saveRowsBatch(patches: Record<string, EntryRow[]>): StoredState {
  const next = { ...allRows(), ...patches }
  persist(next)
  return next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 成组复测数据读取，读不到时回落到初始空态。 */
export function readJson<T>(key: string, fallback: T): T {
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

export function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

export function retestStorageKey(): string {
  return RETEST_KEY
}

export function lockStorageKey(): string {
  return LOCK_KEY
}

type StoredLock = { holder: string; expiresAt: number }

/**
 * 跨终端（多标签页）互斥：同一时刻只允许一个标签页提交复测批次。
 * localStorage 写入在各标签页间同步可见，拿不到锁就让调用方稍后重试。
 */
export function acquireLock(holder: string): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return true
  }
  const now = Date.now()
  const existing = readJson<StoredLock | null>(LOCK_KEY, null)
  if (existing && existing.holder !== holder && existing.expiresAt > now) {
    return false
  }
  writeJson(LOCK_KEY, { holder, expiresAt: now + LOCK_TTL_MS } satisfies StoredLock)
  // 重新读一遍：两个标签页同时写时，以最终落库的 holder 为准，防并发穿透。
  const winner = readJson<StoredLock | null>(LOCK_KEY, null)
  return winner?.holder === holder
}

export function releaseLock(holder: string): void {
  const existing = readJson<StoredLock | null>(LOCK_KEY, null)
  if (existing?.holder === holder) {
    window.localStorage.removeItem(LOCK_KEY)
  }
}

// 另一终端写入后，本标签页的内存缓存作废，下一次读取拿到的就是最新数据。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
    if (event.key === STORAGE_KEY || event.key === RETEST_KEY) {
      listeners.forEach((fn) => fn())
    }
  })
}

const listeners = new Set<() => void>()

/** 复测数据或业务行被本终端/另一终端改动时通知页面刷新。 */
export function subscribeStorage(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyStorageChanged(): void {
  listeners.forEach((fn) => fn())
}
