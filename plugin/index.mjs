// beme 的 DSH 插件外壳 · 第一代（2026-10-29）
//
// 定位：库不动（../src 原样照抄），这里只做"接进宿主"的四件事：
//   ① 把 DSH 的模型借给库当 llm（散装版最大的门槛就在这）
//   ② 注册两个工具：memory_remember / memory_recall
//   ③ 往系统提示词里加一行"你有记忆库"（可选，config.hint 管）
//   ④ 认配置：数据目录 / 召回条数 / 预算
//
// 一代先求"真的能跑、真的会记、真的会翻"，不做面板、不做自动注入上下文、不做定时整理。
//
// ★ 2026-10-29 两次启动失败的教训（都写在这儿，别再犯）：
//   1. cordis.patch.yml 的 name 要写 `beme/dsh`（插件入口），写 `beme` 会解析到库的 main，
//      没有 apply → "failed to import" → 整台 DSH 进安全模式。
//   2. defineTool 的每个工具**必须带 output: { schema, render }**。
//      少这个字段，宿主在 apply 时读 undefined.render 直接崩
//      （报错长这样：Cannot read properties of undefined (reading 'render')）。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 宿主提供的这两个包：插件在 DSH 里跑的时候能解析，从外面的 node 直接跑会 NOT_FOUND。
// 所以"有就用、没有就降级"，一个 import 失败不该把整个插件打死。
let defineTool = (def) => def
try {
  const m = await import('@deepseek-ai/dsh-tools')
  if (typeof m.defineTool === 'function') defineTool = m.defineTool
} catch { /* 用轻量版 */ }

let z = null
try { z = (await import('@deepseek-ai/schemastery')).default } catch { z = null }

// 自动 recall 要往本轮请求里插一条消息，靠这个工厂（拿不到就只是没有自动注入，工具照样能用）
let createUserMessage = null
try {
  const m = await import('@deepseek-ai/dsh-llm')
  if (typeof m.createUserMessage === 'function') createUserMessage = m.createUserMessage
} catch { /* 宿主没给这个包 */ }

/** 工具的 output 形状，抄官方插件（@deepseek-ai/dsh-experimental-tool-agent-team）的 jsonOutput */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  }
}

const OUT = jsonOutput({ type: 'object', additionalProperties: true })

/** 加载器身份 */
export const name = 'beme'

/** 工具注册 + 每轮 pre-step 钩子（agents 服务）；systemPrompt 有就用、没有就跳过 */
export const inject = ['tools', 'agents', 'llm']

/** 配置默认值（没有 schemastery 时就是普通对象，apply 里自己合并） */
export const DEFAULTS = {
  dir: '',
  topN: 8,
  budget: 1800,
  hint: true,
  autoRecall: true,
  // ★ 核心词白名单：这些词不参与泛词过滤（对象的称呼类词 df 天然极高，一刀切会把它们当泛词丢掉）
  coreWords: [],
}

/** 有 schemastery 就交出去让面板校验；没有就用普通对象，宿主照样能把 config 传进来 */
export const Config = z
  ? z.object({
    dir: z.string().default(''),
    topN: z.number().default(8),
    budget: z.number().default(1800),
    hint: z.boolean().default(true),
    autoRecall: z.boolean().default(true),
    coreWords: z.array(z.string()).default([]),
  })
  : DEFAULTS

/** 数据目录：优先 config.dir，其次环境变量，最后 ~/.beme */
function dataDir(config) {
  return config.dir || process.env.BEME_DIR || join(homedir(), '.beme')
}

export function apply(ctx, rawConfig) {
  const config = Object.assign({}, DEFAULTS, rawConfig || {})
  const dir = dataDir(config)
  mkdirSync(dir, { recursive: true })
  // ★ 必须在第一次 import 库之前把目录定下来：src/store.js 在模块顶层读这个变量
  process.env.MEMORY_DIR = dir

  let lib = null
  const load = async () => {
    if (lib) return lib
    const base = new URL('../lib/', import.meta.url)
    lib = {
      store: await import(new URL('store.js', base)),
      write: await import(new URL('write.js', base)),
      read: await import(new URL('read.js', base)),
    }
    return lib
  }

  // ---------- ① 把宿主的模型借给库（★ 用当前会话正在用的那个模型）----------
  // 官方 LLM 服务的真接口是流式的 ctx.llm.stream(...)，没有 ask()。
  // 路由从 agent 身上取（context.agent.options.provider/model），取不到退到第一个已注册提供方。
  const llmFor = (exec) => {
    const svc = ctx.llm
    if (!svc || typeof svc.stream !== 'function') return null

    const routeOf = () => {
      const opts = (exec && exec.agent && exec.agent.options) || {}
      let provider = opts.provider
      let model = opts.model
      if (!provider || !model) {
        let list = []
        try { list = (typeof svc.listProviders === 'function' ? svc.listProviders() : []) || [] } catch { list = [] }
        const first = list[0]
        if (first) {
          provider = provider || first.provider || first.name || first.id
          model = model || first.model || first.defaultModel || (first.models && first.models[0])
        }
      }
      return provider && model ? { provider, model } : null
    }

    return async (prompt) => {
      const route = routeOf()
      if (!route) return ''
      let text = ''
      try {
        const stream = svc.stream({
          ...route,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt) }] }],
        })
        for await (const chunk of stream) {
          if (!chunk) continue
          const t = chunk.type
          if (t === 'text-delta' || t === 'text_delta' || t === 'text') {
            text += chunk.text || chunk.delta || (chunk.content && chunk.content.text) || ''
          } else if (t === 'finish' || t === 'done') {
            break
          }
        }
      } catch { return '' }
      return text
    }
  }

  // ---------- ② 工具（每个都必须带 output） ----------
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '把一件值得长期记住的事记进 beme 记忆库（对方的名字/喜好/约定/重要的事）。一条只记一件事；日常琐事不用记；记的时候安静地记，别在回复里说"我记住了"。',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的事，一句话，主语写清楚' },
      about: { type: 'string', description: '这件事关于谁（名字），可选' },
    },
    output: OUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { write } = await load()
      const text = String(args.text || '').trim()
      if (text.length < 4) return { ok: false, message: '太短，没记' }
      const r = await write.addBlocksFromText(text, {
        llm: llmFor(exec),
        aboutName: String(args.about || ''),
        source: 'tool',
        sourceId: 'beme-tool:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8),
      })
      const ok = r.results.filter((x) => x.ok).length
      return {
        ok: ok > 0,
        message: r.via === 'ai' ? `记下了（模型切成 ${r.pieces} 块）` : `记下了（${ok} 块）`,
        coords: r.results.filter((x) => x.ok).map((x) => x.coord),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '翻 beme 记忆库：想不起对方以前说过什么、喜欢什么、约过什么的时候用。query 写关键词或一句话。',
    parameters: {
      query: { type: 'string', required: true, description: '想找什么' },
      topN: { type: 'number', description: '最多拼几条，默认 8' },
    },
    output: OUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      const { read } = await load()
      const q = String(args.query || '').trim()
      if (!q) return { ok: false, message: '要找什么？' }
      const r = read.contextFor(q, { topN: Number(args.topN) || config.topN, budget: config.budget })
      if (!r.text) return { ok: true, message: '没想起相关的（库里没有，或者词表里抽不到概念）', state: r.state }
      return { ok: true, message: r.text, state: r.state }
    },
  }))

  // ---------- ③ 提示词里告诉她"你有这个库" ----------
  if (config.hint !== false) {
    try {
      ctx.systemPrompt?.section?.({
        name: 'beme:hint',
        order: 90,
        text: '你有一个长期记忆库（beme）：想不起以前的事就调 memory_recall；值得长期记住的事调 memory_remember。两件都别在回复里说出来。',
      })
    } catch { /* 宿主没有 systemPrompt 服务就算了，工具照样能用 */ }
  }

  // ---------- ④ 每轮自动 recall（联想式：想要的时候，东西自己浮上来） ----------
  // 照官方 packages/context/time-context 的写法：钩 agent/pre-step，往本轮请求里插一条消息。
  // 跟"常驻注入"的区别：这段只在**这一句相关**时才插，捞不到一个字都不插（不占系统提示词、不会撑爆）。
  /** 从本轮消息里取最后一条"人说的话" */
  const lastUserText = (msgs) => {
    for (let i = (msgs || []).length - 1; i >= 0; i -= 1) {
      const m = msgs[i]
      if (!m) continue
      const role = m.role || m.type
      if (role !== 'user' && role !== 'human') continue
      const c = m.content
      if (typeof c === 'string') return c.trim()
      if (Array.isArray(c)) {
        const t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n').trim()
        if (t) return t
      }
    }
    return ''
  }

  if (config.autoRecall !== false && createUserMessage && typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async ({ step, signal }, next) => {
      const decision = await next()
      if (!decision || decision.kind === 'reject' || signal?.aborted) return decision
      if (step !== 1) return decision // 一轮只插一次
      const msgs = decision.messages || []
      const q = lastUserText(msgs)
      if (!q || q.length < 2) return decision

      // ★ 用 retrieve() 自己拼，不用 contextFor()：后者自带一层「（你记得这些事，方括号里是…）」
      //   前缀，两层叠起来就成了「（你想起这些…（你记得这些事…））」，模型会读乱。
      let picked = []
      let read = null
      try {
        const lib = await load()
        read = lib.read
        const r = read.retrieve(q, { budget: config.budget, kmax: config.topN, coreWords: config.coreWords })
        picked = (r && r.picked) || []
      } catch { return decision }
      if (!picked.length) return decision

      // ★ 文案改成"直接陈述"：不讲元话术，不写"你想起这些"。
      //   写成它自己知道的事实，模型才会当自己的记忆用，而不是当"用户递来的资料"。
      const seen = new Set()
      const lines = []
      for (const b of picked) {
        const text = String(b.content || '').replace(/\s+/g, ' ').trim()
        if (!text || seen.has(text)) continue
        seen.add(text)
        const ago = typeof read.agoText === 'function' ? read.agoText(b.origin_at || b.created_at) : ''
        // 模糊块带标注
        const tag = b.fuzzy ? '·' + (b.fuzzyWhy || '指代不明') : ''
        lines.push(`- ${ago ? '[' + ago + tag + '] ' : ''}${text.length > 240 ? text.slice(0, 240) + '…' : text}`)
        if (lines.length >= config.topN) break
      }
      if (!lines.length) return decision
      const block = '你知道这些事（都是你自己经历过、记下来的，不是别人告诉你的；' +
        '聊到就自然用，别把旧事当新事说，也别提「记忆」这个词。' +
        '方括号里带「缺主语」「被截断」「过短」的是半句话，别当完整事实用，也不许猜说话的是谁）：\n' + lines.join('\n')

      // 已经在这轮里出现过，就不重复插
      if (msgs.some((m) => JSON.stringify(m).includes(lines[0].slice(2, 30)))) return decision
      try {
        return {
          ...decision,
          messages: [
            ...msgs,
            createUserMessage({
              content: [{ type: 'text', text: block }],
              source: { kind: 'beme', form: 'snapshot', sections: [{ name: 'beme:recall', text: block }] },
            }),
          ],
        }
      } catch { return decision }
    }, { prepend: true })
  }

  // ---------- ⑤ 启动自检 ----------
  ctx.effect?.(() => {
    load().then(({ store }) => {
      try {
        const n = Object.keys(store.loadBlocks().blocks || {}).length
        ctx.logger?.info?.(`[beme] 已挂上：${dir} · ${n} 块 · 自动recall=${config.autoRecall !== false}`)
      } catch { /* 空库不算错 */ }
    })
    return () => {}
  }, 'beme:boot')
}
