// 成组复测台冒烟测试运行器：先用 esbuild 把 TS 冒烟脚本打包，再在 node 里执行。
// 用法：npm run test:remeasure
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const outfile = resolve('node_modules/.cache/remeasure.smoke.mjs')
await mkdir(resolve('node_modules/.cache'), { recursive: true })
await build({
  entryPoints: [resolve('scripts/remeasure.smoke.entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': resolve('src') },
  logLevel: 'error',
})
await import(pathToFileURL(outfile).href)
