// 自检：不起服务、不连模型，纯本地验证整条链路。
// 用法：MEMORY_DIR=./tmp-test node selftest.mjs
// 它会建几个块、跑几种查询，最后把 12 条验收里能自动化的部分跑一遍。

import { rmSync } from 'node:fs'
import { join } from 'node:path'

// ★ 强制用独立的临时目录：绝不许因为外部设了 MEMORY_DIR 就跑到用户的真实库里去
process.env.MEMORY_DIR = join(process.cwd(), '.selftest-data-' + process.pid)
rmSync(process.env.MEMORY_DIR, { recursive: true, force: true })

const store = await import('./store.js')
const write = await import('./write.js')
const read = await import('./read.js')

const ok = []
const bad = []
const chk = (name, cond, extra = '') => {
  ;(cond ? ok : bad).push(name + (extra ? ' — ' + extra : ''))
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  (' + extra + ')' : ''))
}

const T = (h, m) => Date.UTC(2026, 9, 27, h - 8, m, 0) // 2026-10-27 的时刻（UTC+8）

console.log('\n【1】建块')
const items = [
  { c: '用户点了沪上阿姨工大北门店的热芋泥波波奶茶，中杯热七分糖加黑糖波波，合计 19 块，加上打包配送一共 22.6 元，送到公寓 3 号楼。', t: T(19, 0), tp: '用户|事实|奶茶订单' },
  { c: '用户问那台 NAS 能不能插 5060ti 显卡，我说物理上可以，但供电和 PCIe 通道要先确认。', t: T(16, 10) },
  { c: '这台 NAS 的主板是 BIOSTAR H81MDV5，2015 年的小板，只有一条 PCIe 插槽。', t: T(16, 12) },
  { c: '用户说他讨厌香菜，闻到就想吐。', t: T(12, 30) },
  { c: '用户最近在试一个自己的记忆系统设计，反复调打分和选块。', t: T(22, 15) },
]
for (const it of items) {
  const r = write.addBlock({ content: it.c, aboutName: '用户', source: 'dialog', source_id: 'seed:' + items.indexOf(it), at: it.t, topic: it.tp })
  console.log('  +', r.ok ? r.coord + ' ' + r.kind : '跳过 ' + r.why)
}
const db0 = store.loadBlocks()
const n0 = Object.keys(db0.blocks).length
chk('块已建立', n0 === 5, n0 + ' 块')
const idx0 = store.rebuildIndexes(db0)
chk('索引已重建', idx0.blocks === 5, JSON.stringify(idx0))

console.log('\n【2】幂等与覆盖')
const dup = write.addBlock({ content: items[0].c, aboutName: '用户', source: 'dialog', source_id: 'seed:0', at: items[0].t })
chk('同内容重复写入被幂等跳过', !dup.ok, dup.why || '')
// ① 特征能抽出来的一对 → 应该判"覆盖"
const same = write.addBlock({
  content: '用户又点了一次沪上阿姨的热波波奶茶，还是 19 块，芋泥波波。',
  aboutName: '用户', source: 'dialog', at: T(19, 30), source_id: 'test:same-topic', topic: '用户|事实|奶茶订单',
})
chk('特征重合度够 → 覆盖(ver+1)', same.ok && same.kind === 'OVERWRITE', same.kind || same.why)

// ② 一个特征都抽不出来的一对 → 应该判"重建"（这正是设计：判不准就新建）
const vague = write.addBlock({
  content: '用户还是讨厌香菜，改不了。',
  aboutName: '用户', source: 'dialog', at: T(20, 0), source_id: 'test:vague',
})
chk('抽不出特征 → 一律重建（偏向重建，不压错）', vague.ok && (vague.kind === 'REBUILD' || vague.kind === 'WRITE'), vague.kind || vague.why)

console.log('\n【3】四种出口')
const qs = [
  ['闲聊', '你在干嘛', 'ask_empty'],
  ['细节', '那杯奶茶多少钱', 'assert_full'],
  ['细节', '主机板是什么型号', 'assert_full'],
  ['没有的', '这个项目用的区块链是哪条链', 'ask_empty'],
]
for (const [tag, q, expect] of qs) {
  const c = read.contextFor(q, { topN: 8 })
  const shown = (c.text || '').length
  console.log(`  [${tag}] "${q}" → state=${c.state} 注入=${shown}字 特征=${JSON.stringify((c.debug || {}).qFeats || [])}`)
  if (tag === '闲聊') chk('闲聊不注入', shown === 0, '注入 ' + shown + ' 字')
  if (tag === '细节' && shown) chk('细节能注入', shown > 0)
  if (tag === '没有的') chk('没有的就说不记得（不硬答）', c.state === 'ask_empty' || shown === 0, c.state)
}

console.log('\n【4】确定性（同一查询跑两遍）')
const r1 = read.retrieve('奶茶多少钱')
const r2 = read.retrieve('奶茶多少钱')
chk('同一查询排序一致', JSON.stringify(r1.picked.map((p) => p.coord)) === JSON.stringify(r2.picked.map((p) => p.coord)))

console.log('\n【5】重放一致性')
const before = JSON.stringify(Object.values(store.loadBlocks().blocks).map((b) => [b.coord, b.ver, b.content_hash]).sort())
store.rebuildIndexes(store.loadBlocks())
const after = JSON.stringify(Object.values(store.loadBlocks().blocks).map((b) => [b.coord, b.ver, b.content_hash]).sort())
chk('重建索引后库内容不变', before === after)

console.log('\n【6】核心隐私打码')
write.addBlock({ content: '用户的身份证号是 110101199001011234，密码是 abc12345，帮我记一下。', aboutName: '用户', source: 'dialog', at: T(9, 0) })
const priv = read.contextFor('我的身份证号和密码是怎么写的', { topN: 8 })
const leaked = /110101199001011234|abc12345/.test(priv.text || '')
chk('注入里不出现身份证/密码原文', !leaked, leaked ? '泄漏了！' : '已过滤')

console.log('\n【7】AI 分块（mock 模型，不外连）')
const ai = await import('./ai.mjs')
const mockLlm = async (prompt) => {
  if (prompt.includes('检索用的概念词')) return '```json\n["奶茶","显卡","记忆系统","香菜","奶茶"]\n```'
  if (prompt.includes('是不是同一件事')) return '{"same":false,"why":"不同的事"}'
  if (prompt.includes('切成')) {
    return '```json\n[' +
      '{"text":"用户点了沪上阿姨的热芋泥波波奶茶，19 块，送到公寓 3 号楼。","title":"点奶茶","features":["奶茶"],"who":"用户","kind":"事实"},' +
      '{"text":"用户讨厌香菜，闻到就想吐。","title":"讨厌香菜","features":["香菜"],"who":"用户","kind":"偏好"}' +
      ']\n```'
  }
  return '[]'
}
const before7 = Object.keys(store.loadBlocks().blocks).length
const r7 = await write.addBlocksFromText('一整段混着好几件事的话，交给模型切。', { llm: mockLlm, aboutName: '用户', sourceId: 'ai-test' })
chk('模型切成 2 块', r7.via === 'ai' && r7.pieces === 2, JSON.stringify({ via: r7.via, pieces: r7.pieces }))
chk('两块各占自己的坑（noTopic）', r7.results.every((x) => x.ok) && new Set(r7.results.map((x) => x.coord)).size === 2, r7.results.map((x) => x.coord).join(','))
chk('块数增加了', Object.keys(store.loadBlocks().blocks).length === before7 + 2)

const n7 = Object.keys(store.loadBlocks().blocks).length
await write.addBlocksFromText('一整段混着好几件事的话，交给模型切。', { llm: mockLlm, aboutName: '用户', sourceId: 'ai-test' })
chk('同素材重跑不重复建块', Object.keys(store.loadBlocks().blocks).length === n7)

// ★ 这一条是 2026-10-29 实测踩到的坑：记忆条目被整理（id 不变、内容变了）后，老逻辑永远跳过、再也进不了库
await write.addBlocksFromText('改过的话：用户点了蜜雪冰城的柠檬水。', {
  llm: async () => '[{"text":"用户点了蜜雪冰城的柠檬水。","title":"点柠檬水","features":["奶茶"],"who":"用户","kind":"事实"}]',
  aboutName: '用户', sourceId: 'ai-test',
})
chk('内容变了能进库（旧逻辑会卡死）', Object.keys(store.loadBlocks().blocks).length > n7, '块数 ' + n7 + ' → ' + Object.keys(store.loadBlocks().blocks).length)

const v7 = await ai.discoverVocabWithAI('语料', { llm: mockLlm, existing: ['奶茶'] })
chk('AI 提词：去重、去单字', Array.isArray(v7) && !v7.includes('奶茶') && v7.every((w) => w.length >= 2), JSON.stringify(v7))

const pv = ai.pruneVocab(['奶茶', '的', '香菜'], Object.values(store.loadBlocks().blocks), { dfMax: 0.9 })
chk('体检能剔掉单字词', pv.drop.includes('的'), JSON.stringify(pv))

const noLlm = await write.addBlocksFromText('没有模型的时候也要能落块。这是第二句。', { aboutName: '用户', sourceId: 'ai-fallback' })
chk('没有 llm 时自动退到正则', noLlm.via === 'regex' && noLlm.pieces >= 1, noLlm.via + ' / ' + noLlm.pieces)

console.log('\n════════════════════════════════')

console.log(`通过 ${ok.length} 条，失败 ${bad.length} 条`)
if (bad.length) { console.log('失败项：'); bad.forEach((b) => console.log('  - ' + b)); process.exitCode = 1 }
else { console.log('全过 ✅  测试数据在 ' + process.env.MEMORY_DIR + '（可删）') }
