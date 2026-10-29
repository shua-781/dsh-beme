// 挂载示例：把它接到任何一个"会长期说话"的 AI 应用上。
// 这不是能直接跑的代码（宿主各不相同），而是一个照抄就行的骨架。
// 三个挂载点：① 每轮注入 ② 定时搬运 ③ 只读接口。缺一个都跑不起来。

import { join } from 'node:path'
import { contextFor } from './read.js'
import { ingestMemoryItems, addBlock } from './write.js'
import { loadBlocks, rebuildIndexes, loadMeta } from './store.js'

export function mountMemory({ app, dataDir, llm }) {
  process.env.MEMORY_DIR = process.env.MEMORY_DIR || join(dataDir, 'memory')

  // ---------- ① 每轮注入（最重要）----------
  // 宿主每次要把用户的话送进模型之前，调这个，把返回的那段拼进 system prompt。
  // 返回空字符串 = 这一轮不需要记忆（闲聊就别塞，别打扰它）。
  app.onBeforeReply(async ({ chat, userText }) => {
    try {
      const r = contextFor(userText, {
        budget: 2600,   // 注入的 token 预算
        kmax: 16,       // 最多捞几张卡
        topN: 12,       // 最多渲染几段
        kind: chat.kind,
      })
      return r.text || ''
    } catch (e) {
      // ★★ 记忆层出错，绝不许影响正常聊天 ★★
      app.log?.warn('[memory] 注入失败（已忽略）：' + e.message)
      return ''
    }
  })

  // ---------- ② 定时把外部记忆源搬进块库 ----------
  // 如果你的应用已经有一个"记忆条目"存储（比如 memory.json），
  // 让它继续写，这里定期把它搬进块库 —— 幂等，source_id 保证不会重复搬。
  app.every(5 * 60_000, async () => {
    try {
      const items = await app.store.listMemoryItems() // [{id, text, aboutName, at}]
      const r = ingestMemoryItems(items, { topicResolver: llm?.judgeTopic })
      if (r.added) app.log?.info(`[memory] 搬进块库 ${r.added} 条`)
    } catch (e) { app.log?.warn('[memory] 搬运失败：' + e.message) }
  })

  // ---------- ③ 只读接口（自查用）----------
  app.route?.('/memory/stats', async () => {
    const db = loadBlocks()
    const meta = loadMeta()
    return { ok: true, blocks: Object.keys(db.blocks).length, vocab: (meta.vocab || []).length }
  })
  app.route?.('/memory/search', async (req) => {
    const q = req.query?.q || ''
    const { retrieve } = await import('./read.js')
    const r = retrieve(q)
    return { ok: true, state: r.state, debug: r.debug, hits: r.picked.slice(0, 8) }
  })
  app.route?.('/memory/rebuild', async () => ({ ok: true, idx: rebuildIndexes(loadBlocks()) }))

  // ---------- ④ 手动建块（给"用户明确说的事"用）----------
  app.route?.('/memory/add', async (req) => {
    const b = req.body || {}
    return addBlock({
      content: String(b.text || ''),
      aboutName: String(b.aboutName || ''),
      source: 'user',
      topic: String(b.topic || ''),   // 判断层能给出 topic 就给它，给不出退回规则
    })
  })

  return { contextFor, addBlock, ingestMemoryItems }
}

/* ────────────────────────────────────────────────────────────
   三个容易踩的点：

   1. 注入一定要 try/catch 吞异常。
      记忆是你自己写的，但聊天是用户在用的 —— 不能因为记忆挂了就让人说不了话。

   2. 不要每轮都"顺便把这一轮也记下来"。
      块只在"内容要离开上下文的那一刻"建（压缩/归档/换日）。
      每轮都建 → 一天几百张碎卡 → 检索全是噪音。

   3. app.every 里别放长任务。
      如果"搬运"要调模型（判断 topic），那是几分钟的活，
      塞进主事件循环会把聊天卡住 —— 扔到独立的批处理进程里，用文件通信。
   ──────────────────────────────────────────────────────────── */
