// AI 分块与词表（2026-10-29）
//
// 为什么要这个文件：
//   最初的 V3 用正则切句（splitSentences）、正则猜主题（topicOf）、词表 includes 抽特征（featsFromText）。
//   实测下来三条都靠不住：
//     · 正则切句把"多人刷屏"切成半句，一块里混着三件事；
//     · topicOf 拿"谓词 + 后面 2~8 字"拼 topic，拼出「主人|能力|_」「主人|状态|2026」这种垃圾键，
//       不同的事撞进同一个 topic 就互相覆盖（实测一个坑被覆盖 15 次，内容是别人的）；
//     · 词表靠人肉维护，三个月只有 71 个词，问「我叫什么名字」抽不到特征 —— 她答"我不记得"。
//
// 现在：把一个 llm 回调交进来，分块、起标题、抽特征、发现新词都让模型做；
//       llm 不给就走原来的正则，退化但不崩（离线/降级场景）。
//
// llm 的约定（只要求这一个形状，DSH / OpenAI / Ollama / 任何本地模型都能接）：
//   const llm = async (prompt) => '模型输出的字符串'
//   想让它输出 JSON，就在 prompt 里写清楚；解析失败会自动重试一次，再失败就降级。

/** 从模型输出里抠出 JSON（容忍 ```json 围栏、前后废话、单对象） */
export function pickJson(raw) {
  const s = String(raw || '')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : s
  const tries = []
  const a = body.indexOf('['), b = body.lastIndexOf(']')
  if (a >= 0 && b > a) tries.push(body.slice(a, b + 1))
  const c = body.indexOf('{'), d = body.lastIndexOf('}')
  if (c >= 0 && d > c) tries.push(body.slice(c, d + 1))
  for (const t of tries) {
    try { return JSON.parse(t) } catch { /* 下一个 */ }
  }
  return null
}

const KINDS = ['事实', '偏好', '计划', '情绪', '闲聊', '关系', '技术']

/** 分块 + 起标题 + 抽特征：把一段话交给模型切成"一条一件事" */
export function segmentPrompt(text, { aboutName = '', vocab = [], limit = 12 } = {}) {
  return `把下面这段内容切成"一条一件事"的记忆块，给每块起个短标题、抽特征词。

规则：
- 一块只写一件事。多人刷屏（好几个人的话挤在一起）按"谁说了什么、她回了什么"拆开，别整段塞成一块。
- 纯表情、纯图片占位、纯灌水、别人的隐私八卦没有信息量 → 不要输出这一条。
- 保留原话的口气和情绪，不要改写成书面语，不要替说话人美化。
- 特征词必须从下面的【词表】里挑，最多 4 个；挑不到就给空数组，**不许自己造词**。
- 标题 12 个字以内，用来说明"这件事是什么"，不要标题党。
- who 写这件事故关于谁（人名/主人/我自己/群名），kind 只能是：${KINDS.join('、')}。
- 涉及的人名不要改写；同一个人的不同叫法（本名/群名片/外号）不要当成两个人。

【词表】${vocab.length ? vocab.join('、') : '（空）'}
${aboutName ? `【这段主要关于】${aboutName}` : ''}

【内容】
${String(text || '').slice(0, 12000)}

只输出 JSON 数组，不要解释、不要 Markdown：
[{"text":"这一块的话","title":"短标题","features":["词表里的词"],"who":"谁","kind":"${KINDS[0]}"}]
最多 ${limit} 条。`
}

/** 调模型分块；失败或模型不可用 → 返回 null（调用方自己退到正则） */
export async function segmentWithAI(text, { llm, aboutName = '', vocab = [], limit = 12, retry = 1 } = {}) {
  if (typeof llm !== 'function') return null
  const prompt = segmentPrompt(text, { aboutName, vocab, limit })
  for (let i = 0; i <= retry; i += 1) {
    let raw
    try { raw = await llm(prompt) } catch { return null }
    const data = pickJson(raw)
    if (!Array.isArray(data)) continue
    const out = []
    for (const it of data) {
      const t = String((it && it.text) || '').trim()
      if (t.length < 4) continue
      out.push({
        text: t,
        title: String((it.title || '')).trim().slice(0, 24),
        features: Array.isArray(it.features) ? it.features.filter((w) => typeof w === 'string' && w.length >= 2).slice(0, 6) : [],
        who: String(it.who || '').trim(),
        kind: KINDS.includes(it.kind) ? it.kind : '',
      })
    }
    if (out.length) return out
  }
  return null
}

/** 词表扩充：让模型从语料里提"值得当检索概念"的词（≥2 字，去掉泛词交给 pruneVocab） */
export function vocabPrompt(corpus, { existing = [], max = 40 } = {}) {
  return `从下面的语料里，找出值得当作"检索用的概念词"的词。

要求：
- 2~6 个字；是具体的人、物、地方、事、关系、技术名词（比如"奶茶""姐姐""课表""SnowLuma"）
- 不要虚词、不要句子碎片（"要不要我""可以直接"这种一律不算）、不要单独的动词
- 不要单字（单字会把不相干的事搅在一起）
- 已经在【现有词表】里的不要重复输出

【现有词表】${existing.join('、') || '（空）'}

【语料】
${String(corpus || '').slice(0, 16000)}

只输出 JSON 数组，最多 ${max} 个：["词1","词2"]`
}

export async function discoverVocabWithAI(corpus, { llm, existing = [], max = 40 } = {}) {
  if (typeof llm !== 'function') return null
  const prompt = vocabPrompt(corpus, { existing, max })
  for (let i = 0; i < 2; i += 1) {
    let raw
    try { raw = await llm(prompt) } catch { return null }
    const data = pickJson(raw)
    if (!Array.isArray(data)) continue
    const seen = new Set(existing)
    const out = []
    for (const w of data) {
      const x = String(w || '').trim()
      if (x.length < 2 || x.length > 8 || seen.has(x)) continue
      seen.add(x)
      out.push(x)
    }
    if (out.length) return out
  }
  return null
}

/** 两条是不是同一件事（替代"特征重合 ≥0.5 就覆盖"的启发式） */
export function sameEventPrompt(a, b) {
  return `这两条记忆是不是同一件事（能合成一句、说的是同一个事实/同一段经历的同一面）？

A：${String(a || '').slice(0, 300)}
B：${String(b || '').slice(0, 300)}

只输出 JSON：{"same":true,"why":"十个字以内的理由"}`
}

export async function sameEventWithAI(a, b, { llm } = {}) {
  if (typeof llm !== 'function') return null
  let raw
  try { raw = await llm(sameEventPrompt(a, b)) } catch { return null }
  const d = pickJson(raw)
  if (!d || typeof d !== 'object') return null
  return { same: Boolean(d.same), why: String(d.why || '').slice(0, 40) }
}

/** 词表体检：覆盖率过高的不是"概念"，是"背景词"（每个块都有它，检索时全是噪声） */
export function pruneVocab(vocab, blocks, { dfMax = 0.45 } = {}) {
  const list = Array.isArray(blocks) ? blocks : Object.values(blocks || {})
  const N = list.length || 1
  const keep = [], drop = []
  for (const w of vocab || []) {
    if (typeof w !== 'string' || w.length < 2) { drop.push(w); continue }
    const df = list.filter((b) => String(b.content || '').includes(w)).length
    if (df / N > dfMax) drop.push(w)
    else keep.push(w)
  }
  return { keep, drop }
}
