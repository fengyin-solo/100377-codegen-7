// 成组复测台业务逻辑冒烟测试：用 esbuild 打包后在 node 里跑，localStorage 用内存模拟。
import {
  adjustRemeasureStatsRule,
  archiveRemeasureBatch,
  createRemeasureBatch,
  executeRemeasureBatch,
  listRemeasureBatches,
  listRemeasureCandidates,
  loadRemeasureStatsRule,
} from '@/api/remeasure-service'
import { listRows, mutateRows, resetRows } from '@/data/local-store'

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

// 初始数据
resetRows('crosssection')
resetRows('stationhouse')
resetRows('station')

const candidates = listRemeasureCandidates()
assert(candidates.length === 4, `可编组记录 4 条（已校核除外），实际 ${candidates.length}`)
assert(candidates.find((c) => Number(c.row.id) === 1)?.river === '清江', '记录1 河流推导为清江')

// 1. 单条记录不能成组
let r = createRemeasureBatch([1])
assert(!r.ok && r.message.includes('至少'), '单条记录拒绝编组')

// 2. 混合河流拒绝
r = createRemeasureBatch([1, 5])
assert(!r.ok && r.message.includes('同一河流'), '混合河流拒绝编组')

// 3. 混合管理单位拒绝
r = createRemeasureBatch([1, 4])
assert(!r.ok && r.message.includes('不允许混合管理单位'), '混合管理单位拒绝编组')

// 4. 同河流同单位编组成功，生成校核清单与站房配合事项
const todosBefore = listRows('stationhouse').length
r = createRemeasureBatch([1, 2])
assert(r.ok && !r.duplicated && !!r.batch, '同河流同单位编组成功')
assert(r.batch!.batchNo === 'REME-0001', `批次号 REME-0001，实际 ${r.batch!.batchNo}`)
assert(r.batch!.summary.checklist.length === 2, `校核清单 2 条，实际 ${r.batch!.summary.checklist.length}`)
assert(r.message.includes('已落库') && r.message.includes('完成率'), '落库后返回仍保留复测摘要')
const afterCreate = listRows('crosssection')
assert(afterCreate.find((x) => Number(x.id) === 1)!.status === '需重测', '记录1 已流转需重测')
assert(afterCreate.find((x) => Number(x.id) === 2)!.status === '需重测', '记录2 已流转需重测')
const todos = listRows('stationhouse')
assert(todos.length === todosBefore + 1, `站房配合事项新增 1 项，实际新增 ${todos.length - todosBefore}`)
assert(todos[todos.length - 1]['维护类型'] === '配合事项', '配合事项类型正确')
assert(String(todos[todos.length - 1]['维护内容']).includes('REME-0001'), '配合事项内容关联批次号')

// 5. 幂等：两终端并发提交只生效一次（乱序同集合）
const batchesBefore = listRemeasureBatches().length
r = createRemeasureBatch([2, 1])
assert(r.ok && r.duplicated === true && r.batch!.batchNo === 'REME-0001', '重复提交命中幂等返回既有批次')
assert(listRemeasureBatches().length === batchesBefore, '重复提交未新增批次')
assert(listRows('stationhouse').length === todosBefore + 1, '重复提交未新增站房配合事项')

// 6. 部分失败：模拟中断，批次停在断点
r = executeRemeasureBatch(1, { simulateFailure: true })
assert(r.ok && r.batch!.status === '部分失败', '模拟中断后批次为部分失败')
assert(r.batch!.items[0].state === '复测失败' && r.batch!.items[1].state === '待执行', '首项失败、其余待执行')
assert(listRows('crosssection').find((x) => Number(x.id) === 1)!.status === '需重测', '失败断面记录保持需重测不回滚')

// 7. 断点续执行：从未完成处继续，全部成功
r = executeRemeasureBatch(1)
assert(r.ok && r.batch!.status === '已完成', '继续执行后批次完成')
assert(r.batch!.summary.succeeded === 2 && r.batch!.summary.completionRate === 1, '完成率 100%')
const rowsAfterExec = listRows('crosssection')
assert(rowsAfterExec.find((x) => Number(x.id) === 1)!.status === '待校核', '记录1 复测成功转待校核')
assert(rowsAfterExec.find((x) => Number(x.id) === 2)!.status === '待校核', '记录2 复测成功转待校核')

// 8. 已完成批次不能重复执行
r = executeRemeasureBatch(1)
assert(!r.ok && r.message.includes('无需重复执行'), '已完成批次拒绝重复执行')

// 9. 归档
r = archiveRemeasureBatch(1)
assert(r.ok && r.batch!.archived, '批次1 归档成功')

// 10. 既有批次已归档，同组断面可开新一轮复测
r = createRemeasureBatch([1, 2])
assert(r.ok && !r.duplicated && r.batch!.batchNo === 'REME-0002', '归档后允许新一轮复测批次')

// 11. 统计规则调整：重算未归档记录，已归档不动
executeRemeasureBatch(2, { simulateFailure: true }) // REME-0002 一项失败
const before1 = listRemeasureBatches().find((b) => b.id === 1)!
const adj = adjustRemeasureStatsRule()
assert(adj.rule.version === 2 && adj.rule.mode === 'processed', '统计规则升级到 v2 已处理口径')
assert(adj.message.includes('已重算 1 个未归档批次'), `只重算未归档批次，实际：${adj.message}`)
const after1 = listRemeasureBatches().find((b) => b.id === 1)!
const after2 = listRemeasureBatches().find((b) => b.id === 2)!
assert(after1.summary.ruleVersion === before1.summary.ruleVersion, '已归档批次摘要保持原规则版本')
assert(after2.summary.ruleVersion === 2 && after2.summary.completionRate === 0.5, '未归档批次按新规则重算（失败计入已处理 50%）')

// 12. 再调回成功数口径
const adj2 = adjustRemeasureStatsRule()
assert(adj2.rule.version === 3 && adj2.rule.mode === 'success', '统计规则切回成功数口径 v3')
const final2 = listRemeasureBatches().find((b) => b.id === 2)!
assert(final2.summary.completionRate === 0, '按成功数口径重算完成率为 0')

// 13. 既有待校核记录兼容：同河流既有待校核记录随新批次进入校核清单
//     先完成并归档 REME-0002，再把记录5改成清江同单位的待校核记录，模拟上线前已存在的数据
executeRemeasureBatch(2)
archiveRemeasureBatch(2)
mutateRows('crosssection', (rows) =>
  rows.map((row) =>
    Number(row.id) === 5
      ? { ...row, 所在河流: '清江', 管理单位: '清江水文中心', status: '待校核' }
      : row,
  ),
)
r = createRemeasureBatch([1, 2])
assert(r.ok && r.batch!.batchNo === 'REME-0003', '新一轮批次 REME-0003 创建成功')
assert(r.batch!.summary.checklist.length === 3, `校核清单纳入既有待校核记录共 3 条，实际 ${r.batch!.summary.checklist.length}`)
assert(
  r.batch!.summary.checklist.some((entry) => entry.includes('CROS-0005') && entry.includes('既有待校核')),
  '既有待校核记录 CROS-0005 随批次一并校核',
)

const rule = loadRemeasureStatsRule()
assert(rule.version === 3, `规则版本持久化，实际 v${rule.version}`)

console.log(process.exitCode ? '--- 存在失败用例 ---' : '--- 全部通过 ---')
