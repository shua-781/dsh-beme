// 读路径（V3 · 40 号书卷六）
// 十二步：抽特征 → 门 → 两路候选 → f2>0 过滤 → 打分 → 并列随机 → 多抽 → 聚线 → 拆槽 → 三判据 → 四态 → 注入
// 铁律：f2=0 不许进上下文；并列用 hash(查询) 种子；判据串联不并联；拼不齐就问主人

import { loadBlocks, loadIdx, loadMeta, fromISO } from './store.js'

export const W = { f1: 0.25 / 0.85, f2: 0.40 / 0.85, f4: 0.20 / 0.85 } // f3 恒 0 不参与，重归化
export const TAU = 7
export const TOK = 1.6
const GATE_OF_KIND = { private: 'R', group: 'R' }

export function agoText(iso, now = Date.now()) {
  const ms = typeof iso === 'number' ? iso : fromISO(iso)
  const d = Math.max(0, now - ms) / 1000
  if (d < 60) return '刚刚'
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前'
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前'
  if (d < 86400 * 2) return '昨天'
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前'
  return Math.floor(d / 86400 / 30) + ' 个月前'
}

function jac(a, b) {
  const A = new Set(a || []), B = new Set(b || [])
  if (!A.size && !B.size) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

function median(xs) {
  if (!xs.length) return 0
  const y = xs.slice().sort((a, b) => a - b)
  const n = y.length
  return n % 2 ? y[(n - 1) / 2] : (y[n / 2 - 1] + y[n / 2]) / 2
}

function hashSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

function rng(seed) {
  let x = seed || 1
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000 }
}

/** ① 抽特征：词表里的概念名出现在查询里就算命中（featIdx 可为对象或数组） */
const SLOT_WORDS = /^(几点|多少|几个|几块|哪|哪里|哪个|哪天|什么时候|多久|几时|什么|多少号|多少钱)$/

export function featsOf(query, featIdx) {
  const q = String(query || '')
  if (!q) return []
  const keys = Array.isArray(featIdx) ? featIdx : Object.keys(featIdx || {})
  // 槽词（几点/多少钱/哪里…）是"要答的空"，不是"主题"，不参与特征匹配
  return keys.filter((k) => k.length >= 2 && !SLOT_WORDS.test(k) && q.includes(k))
}

/** 槽位（40 号书 §6.4） */
const SLOTS = [
  { name: '是否', q: /吗|没|有没有|行不行|定了没|到没到|成不成|对不对|是不是/, f: /有没有|没|定了|行|成|可以|到|好|是|不用|别/ },
  { name: '数量', q: /多少钱|几块|几个|多少号|价格|多少|几次/, f: /\d+(?:\.\d+)?\s*(?:块|元|块钱)|\d{6,}/ },
  { name: '时间', q: /几点|哪天|什么时候|多久|几月/, f: /\d{1,2}:\d{2}|\d+\s*分钟|昨天|今天|明天|前天/ },
  { name: '地点', q: /哪|哪里|哪个门|哪个校区|什么地方/, f: /校区|号楼|公寓|宿舍|店|区|楼/ },
  { name: '型号', q: /什么型号|哪个型号|型号|什么版本|什么配置/, f: /(?:rtx|gtx|rx\s?\d|5060|4090|\d{3,4}\s*(?:ti|super))|pcie|nas|h81|b560/i },
]

export function slotsOf(query) {
  const q = String(query || '')
  return SLOTS.filter((s) => s.q.test(q)).map((s) => s.name)
}

/** ② 打分（唯一函数；f3 恒 0 不参与） */
export function scoreOf(block, qFeats, qGates, now, idf) {
  const bf = block.features || []
  const inter = bf.filter((f) => qFeats.includes(f))
  const gatesOf = [block.gate_main].concat(block.gate_sub || []).filter(Boolean)
  let f1 = 0
  for (const g of gatesOf) if (qGates.includes(g)) f1 = Math.max(f1, g === block.gate_main ? 1 : 0.4)
  const den = qFeats.reduce((s, f) => s + (idf[f] || 1), 0) || 1e-9
  const num = inter.reduce((s, f) => s + (idf[f] || 1), 0)
  const f2 = num / den
  const ms = fromISO(block.origin_at || block.created_at)
  const f4 = Math.exp(-Math.max(0, now - ms) / 86400000 / TAU)
  return { s: W.f1 * f1 + W.f2 * f2 + W.f4 * f4, f1, f2, f4, inter }
}

export function retrieve(query, opts = {}) {
  const now = opts.now || Date.now()
  const budget = opts.budget || 2600
  const kmax = opts.kmax || 16
  const o = Object.assign({ separable: 0.08, ratio: 1.10, lineFit: 0.30 }, opts || {})

  const db = loadBlocks()
  const all = Object.values(db.blocks || {})
  if (!all.length) return { state: 'ask_empty', reason: '空库', picked: [], lines: [], slots: [], missing: [], debug: {} }

  const featIdx = loadIdx('feat', {})
  const meta = loadMeta()
  const vocabKeys = Array.isArray(meta.vocab) ? meta.vocab : []
  const allKeys = Array.from(new Set(vocabKeys.concat(Object.keys(featIdx || {}))))
  const N = all.length
  const idf = {}
  for (const f of allKeys) idf[f] = Math.log((N + 1) / (((featIdx[f] || []).length) + 0.5))

  let qFeats = featsOf(query, allKeys)
  // ★ 泛词过滤（实测教训）：df/N > 0.15 的词不是"主题"，是"背景词"。
  // 反例：问「光发表情什么意思」抽到「表情」→ 命中 69/347 块 → 注入一整段表情包记忆 → 她跟着只发表情。
  // 泛词不计入查询特征；全被滤掉就当"抽不到特征"，宁可不注入。
  const DF_MAX = 0.15
  const DF_MIN_ABS = 10   // ★ 小样本保护：块总数少的时候，df/N 很容易超阈值把正常词误杀
  const dropped = qFeats.filter((f) => {
    const df = (featIdx[f] || []).length
    return df >= DF_MIN_ABS && df / Math.max(1, N) > DF_MAX
  })
  if (dropped.length) qFeats = qFeats.filter((f) => dropped.indexOf(f) < 0)
  const genericDropped = dropped
  const qGates = [GATE_OF_KIND[opts.kind] || 'R', 'L', 'T', 'S', 'P', 'E', 'K']
  if (!qFeats.length) {
    // ★ 兜底（2026-10-28 实测加）：词表里没有这个概念时，别直接说"不记得"，
    //   先用内容子串匹配捞一次。词表只有几十个词时，很多话根本抽不到特征 ——
    //   这是设计已知的天花板（词表会长，但前期很薄）。宁可能搜到，也别空手。
    const q = String(query || '').trim().slice(0, 24)
    const hits = q ? all.filter((b) => String(b.content || '').includes(q)) : []
    if (hits.length) {
      hits.sort((a, b) => String(b.origin_at || b.created_at).localeCompare(String(a.origin_at || a.created_at)))
      const picked2 = hits.slice(0, kmax).map((b) => Object.assign({}, b, { s: 0.5, f1: 0, f2: 1, f4: 1, inter: [], tokens: Math.ceil(String(b.content || '').length * TOK) }))
      return {
        state: 'assert_full',
        reason: '词表无此概念，走内容子串兜底',
        picked: picked2,
        lines: [{ key: 'fallback', items: picked2 }],
        slots: slotsOf(query),
        missing: [],
        debug: { qFeats, fallback: true, N, vocab: allKeys.length, hits: hits.length },
      }
    }
    return { state: 'ask_empty', reason: '特征抽空（词表里没有）', picked: [], lines: [], slots: slotsOf(query), missing: [], debug: { qFeats, N, vocab: allKeys.length } }
  }

  const byCoord = {}
  for (const b of all) byCoord[b.coord] = b
  const cand = new Set()
  for (const f of qFeats) for (const c of (featIdx[f] || [])) cand.add(c)

  const scored = []
  for (const c of cand) {
    const b = byCoord[c]
    if (!b) continue
    scored.push(Object.assign({}, b, scoreOf(b, qFeats, qGates, now, idf)))
  }
  // ★ 来源降权：群聊闲聊块信噪比低（实测会顶掉真正相关的生活块），乘 0.7
  for (const x of scored) if (x.source === 'group' || x.source === '群聊') x.s = x.s * 0.7
  // ★ 可用性铁律：f2 = 0 的块不许进上下文
  const usable = scored.filter((x) => x.f2 > 0)
  usable.sort((a, b) => b.s - a.s)

  // ★ 并列随机（种子 = 查询文本哈希）
  const rand = rng(hashSeed(String(query)))
  for (let i = 0; i < usable.length;) {
    let j = i
    while (j + 1 < usable.length && Math.abs(usable[j + 1].s - usable[i].s) < 1e-9) j++
    if (j > i) {
      const g = usable.slice(i, j + 1)
      for (let k = g.length - 1; k > 0; k--) {
        const r2 = Math.floor(rand() * (k + 1))
        const t = g[k]; g[k] = g[r2]; g[r2] = t
      }
      usable.splice(i, j - i + 1, ...g)
    }
    i = j + 1
  }

  // ★ 多抽：K 上限 + token 预算
  const picked = []
  let used = 0
  for (const x of usable) {
    if (picked.length >= kmax) break
    const tk = Math.max(1, Math.ceil(String(x.content || '').length * TOK))
    if (used + tk > budget) continue
    picked.push(Object.assign({}, x, { tokens: tk }))
    used += tk
  }

  // ★ 聚线
  const lines = []
  for (const p of picked) {
    const key = p.line_id || p.origin || p.coord
    let ln = lines.find((l) => l.key === key)
    if (!ln) { ln = { key, items: [] }; lines.push(ln) }
    ln.items.push(p)
  }
  for (const l of lines) l.items.sort((a, b) => fromISO(a.origin_at || a.created_at) - fromISO(b.origin_at || b.created_at))
  const mainLine = lines.slice().sort((a, b) => b.items.length - a.items.length)[0]

  // ★ 拆槽 + 填空（记下填充来自哪条线）
  const need = slotsOf(query)
  const filled = {}
  const missing = []
  for (const name of need) {
    const spec = SLOTS.find((s) => s.name === name)
    let src = null
    for (const l of lines) {
      for (const it of l.items) {
        if (spec.f.test(String(it.content || ''))) { src = { line: l.key, coord: it.coord, text: String(it.content || '').slice(0, 60) }; break }
      }
      if (src) break
    }
    if (src) filled[name] = src
    else missing.push(name)
  }

  // ★ 三判据串联（先并列，再槽）
  const margin = usable.length >= 2 ? usable[0].s - usable[1].s : 1
  const ratio = usable.length >= 2 ? usable[0].s / Math.max(usable[1].s, 1e-9) : 99
  const separable = margin >= o.separable && ratio >= o.ratio
  const lineShare = mainLine ? mainLine.items.length / Math.max(1, picked.length) : 0
  // ★ "好并列"的真判据：top-k 内部特征一致性（对话块每块自成一线，line_id 帮不上忙）
  const topk = picked.slice(0, 6)
  const js = []
  for (let i = 0; i < topk.length; i++) for (let j = i + 1; j < topk.length; j++) js.push(jac(topk[i].features, topk[j].features))
  const cohesion = median(js)
  const lineFit = Math.max(lineShare, cohesion)

  let state
  // ★ 关键判据（实测得出）：有没有哪一块"同时命中查询的全部特征"（f2 ≈ 1）
  //   有 → 库里真有这么一件事，可以答；
  //   没有（f2 明显 < 1）→ 查询是复合概念而库里没有，属于"分不清"，必须问主人。
  const topF2 = picked.length ? picked[0].f2 : 0
  const ambiguous = !separable && topF2 < 0.9 && lineFit < o.lineFit
  if (ambiguous) state = 'ask_ambiguous'
  else if (!need.length) state = 'assert_full'
  else if (!missing.length) state = 'assert_full'
  else if (Object.keys(filled).length >= 1) state = 'assert_partial'
  else state = 'ask_empty'

  return {
    state, picked, lines, slots: need, missing, filled,
    debug: { qFeats, genericDropped, N, cand: cand.size, usable: usable.length, margin, ratio, lineFit, cohesion, lineShare, topF2, used, kmax, budget, vocab: allKeys.length },
  }
}

/** 注入段落（出口四态 → 说人话） */
const PRIV_ASK = /能不能说|可不可以说|可以告诉|说给别人|群里|别人|外人|公开|能讲吗|能发吗/
const PRIV_HIT = /地址|电话|手机号|身份证|密码|银行卡|收货|住址/

export function contextFor(query, opts = {}) {
  const r = retrieve(query, opts)
  if (!r.picked.length) return { text: '', state: r.state, debug: r.debug }

  // ★ 隐私护栏（40 号书 §8.1 的执行层）：主人问"能不能说"时，不许把隐私原文摆出来
  if (PRIV_ASK.test(String(query || '')) && r.picked.some((p) => PRIV_HIT.test(String(p.content || '')))) {
    return {
      text: '（这里有主人的隐私（地址/电话一类）。规矩是：只给主人自己用，任何人问、任何群都不复述，也不主动提。真要回，就回「这个不能对外说」。）',
      state: 'privacy_guard', debug: r.debug, missing: r.missing,
    }
  }
  const shown = []
  const cap = r.state === 'ask_ambiguous' ? 3 : (opts.topN || 12)
  for (const p of r.picked.slice(0, cap)) {
    const t = String(p.content || '').replace(/\s+/g, ' ').slice(0, 120)
    if (!t) continue
    shown.push('[' + agoText(p.origin_at || p.created_at) + '] ' + t)
  }
  if (!shown.length) return { text: '', state: r.state, debug: r.debug }

  let head = '（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：'
  if (r.state === 'ask_ambiguous') {
    head = '（下面这几件是对得上的不同的事，你分不清主人问的是哪件，先别硬说，问了再答：'
  } else if (r.state === 'assert_partial') {
    head = '（你记得这些，但' + r.missing.join('、') + '这项没记到，说的时候别编，缺就问主人：'
  }
  return { text: head + shown.join('；') + '）', state: r.state, debug: r.debug, missing: r.missing }
}
