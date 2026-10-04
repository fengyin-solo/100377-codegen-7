// 冒烟测试入口：先装 localStorage 内存模拟，再加载业务逻辑。
const store = new Map<string, string>()
// @ts-expect-error 测试环境模拟浏览器 window
globalThis.window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
}

await import('./remeasure.smoke')
