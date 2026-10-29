// 写路径（V3 · 40 号书卷五）
// 动作：建块 / 覆盖 ver+1 / 重建新坑 / 事件日志 / 索引增量 / 幂等
// 铁律：先写日志再写库；判不准一律新建（偏向重建）；一个坑只住一件事

import {
  loadBlocks, saveBlocks, loadSlots, saveSlots, appendEvent, toISO,
  nextCoord, loadIdx, saveIdx, loadMeta, saveMeta, rebuildIndexes,
} from './store.js'
import { segmentWithAI } from './ai.mjs'

// 种子词表（初版：2026-10-27 全天语料的新词发现 + 概念词典，已去掉功能字开头的垃圾词）
export const SEED_VOCAB = ["记忆", "人格", "日记", "架构", "框架", "协议", "封号", "插件", "消息", "群聊", "群友", "表情包", "动画表情", "奶茶", "波波", "芋泥", "黑糖", "沪上阿姨", "霸王茶姬", "蜜雪冰城", "外卖", "美团", "下单", "订单", "骑手", "照片", "拍照", "相册", "象棋", "下棋", "姐姐", "端口", "显卡", "主板", "供电", "电源", "配置", "nas", "课程", "上课", "作业", "实验", "考试", "睡眠", "晚安", "熬夜", "几点", "早睡", "地址", "收货地址", "支付", "免密支付", "确认支付", "分析化学", "电工电子", "呼和浩特", "湖北荆门", "主人", "白米饭", "火锅", "唱歌", "翻唱", "语音", "空间", "说说", "动态", "贴纸", "表情", "波波奶茶", "黑糖波波", "芋泥波波", "珍珠奶茶", "铃音粉狐", "热饮专区", "兵七进一", "支付确认", "马二进三", "告诉主人", "主人私聊", "兵三进一", "购物车里", "要不要我", "今天中午", "支付方式", "美团支付", "回复主人", "浏览器里", "可以直接", "零下五度", "小额免密", "操作能力", "走车八进", "规格弹窗", "地址列表", "现在需要", "或者直接", "表情表情"]

const GATE_BY_FEATURE = {
  表情包: 'P', 动画表情: 'P', 照片: 'P', 拍照: 'P', 相册: 'P', 贴纸: 'P',
  奶茶: 'L', 波波: 'L', 芋泥: 'L', 黑糖: 'L', 沪上阿姨: 'L', 霸王茶姬: 'L', 蜜雪冰城: 'L', 热饮专区: 'L',
  外卖: 'L', 美团: 'L', 下单: 'L', 订单: 'L', 骑手: 'L', 白米饭: 'L', 火锅: 'L',
  睡眠: 'L', 晚安: 'L', 熬夜: 'L', 几点: 'L', 早睡: 'L',
  记忆: 'T', 人格: 'T', 架构: 'T', 框架: 'T', 协议: 'T', 封号: 'T', 插件: 'T',
  显卡: 'T', 主板: 'T', 供电: 'T', 电源: 'T', 配置: 'T', nas: 'T',
  课程: 'S', 上课: 'S', 作业: 'S', 实验: 'S', 考试: 'S', 分析化学: 'S', 电工电子: 'S',
  群聊: 'R', 群友: 'R', 姐姐: 'R', 主人: 'R',
  日记: 'E', 空间: 'E', 说说: 'E', 动态: 'E', 唱歌: 'E', 翻唱: 'E',
  象棋: 'K', 下棋: 'K',
  地址: 'P', 收货地址: 'P', 支付: 'P', 免密支付: 'P', 确认支付: 'P',
}

const PRED = [
  ['偏好', /喜欢|爱喝|爱吃|爱|中意|讨厌|不喜欢|吃不惯|想吃|想喝|馋/],
  ['拥有', /有(?!个|点|些|会儿|空)|买了|买|丢了|送人|换了|存着/],
  ['计划', /要|打算|答应|预计|说好|明天|后天|周末|等会/],
  ['事实', /发生了|做了|去了|吃了|喝了|睡了|发了|写了|说了|点了|到了/],
  ['能力', /会|能不能|擅长|懂|学会了/],
  ['过敏', /过敏|不舒服|忌口|难受/],
  ['状态', /是|在|处于|在读|住在/],
]

export function loadVocab() {
  const m = loadMeta()
  if (!m.vocab || !m.vocab.length) { m.vocab = SEED_VOCAB.slice(); saveMeta(m) }
  return m.vocab
}

export function saveVocab(list) {
  const m = loadMeta()
  m.vocab = Array.from(new Set((list || []).filter((x) => typeof x === 'string' && x.length >= 2)))
  saveMeta(m)
  return m.vocab
}

/** 特征抽取：只从词表里选（词表不爆，且和查询侧匹配逻辑一致） */
/** 去括号：括号里是补充说明，不作特征来源（实测：地址那条括号里有"点奶茶"，会让奶茶查询命中地址块）*/
export function stripBrackets(text) {
  return String(text || '').replace(/（[^）]*）|\([^)]*\)/g, '')
}

export function featsFromText(text, vocab) {
  const t = stripBrackets(text)
  return Array.from(new Set((vocab || []).filter((w) => t.includes(w))))
}

/** 一条老记忆常混着好几件事 → 按句子切开，一段一块（<60 字的不切） */
export function splitSentences(text) {
  const t = String(text || '').trim()
  if (t.length <= 60) return [t]
  const raw = t.split(/(?<=[。；;！!？?])|\n+/).map((x) => x.trim()).filter(Boolean)
  if (raw.length <= 1) return [t]
  const out = []
  for (const piece of raw) {
    if (out.length && piece.length < 14) out[out.length - 1] = out[out.length - 1] + piece
    else out.push(piece)
  }
  return out.filter((x) => x.length >= 6)
}

export function topicOf(text, aboutName) {
  const t = stripBrackets(text)
  const subj = aboutName && String(aboutName).trim() ? String(aboutName).trim() : '主人'
  for (const [p, rx] of PRED) {
    const m = rx.exec(t)
    if (!m) continue
    const rest = t.slice(m.index + m[0].length).replace(/^[的了地吧呢啊，、。：: ]+/, '')
    const raw = (rest.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}/) || [''])[0]
    const obj = raw.replace(/(吧|呢|啊|呀|嘛|了|哦|的|啦)$/, '')
    return subj + '|' + p + '|' + (obj || '_')
  }
  return null
}

function gateOf(features) {
  for (const f of features) if (GATE_BY_FEATURE[f]) return GATE_BY_FEATURE[f]
  return 'R'
}

function hashOf(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16)
}

function appendEdge(db, from, to, why) {
  db.edges = db.edges || []
  db.edges.push({ from, to, type: 'follows', w: 1, since: toISO(Date.now()), why })
}

function bumpIdx(db, coord) {
  const b = db.blocks[coord]
  if (!b) return
  const feat = loadIdx('feat', {}), gate = loadIdx('gate', {}), topic = loadIdx('topic', {}), chain = loadIdx('chain', {})
  for (const f of b.features || []) { if (!(feat[f] || []).includes(coord)) (feat[f] = feat[f] || []).push(coord) }
  const g = b.gate_main
  if (g && !(gate[g] || []).includes(coord)) (gate[g] = gate[g] || []).push(coord)
  if (b.topic && !(topic[b.topic] || []).includes(coord)) (topic[b.topic] = topic[b.topic] || []).push(coord)
  const o = b.origin || coord
  if (!(chain[o] || []).includes(coord)) (chain[o] = chain[o] || []).push(coord)
  saveIdx('feat', feat); saveIdx('gate', gate); saveIdx('topic', topic); saveIdx('chain', chain)
}

/** 建块（幂等：同 source_id + 同内容跳过；内容变了就走自己的坑重建，别卡死） */
export function addBlock({ content, features, aboutName = '', source = 'manual', source_id = '', at = Date.now(), topic: topicIn = '', noTopic = false }) {
  const text = String(content || '').trim()
  if (text.length < 4) return { ok: false, why: '太短' }

  const meta = loadMeta()
  const synced = meta.synced || {}
  const hash = hashOf(text)
  if (source_id && synced[source_id]) {
    const prev = loadBlocks().blocks[synced[source_id]]
    // ★ 2026-10-29 修：老逻辑只看 synced 有没有这个 source_id 就跳过 —— 记忆条目被整理（id 不变、内容变了）
    //   之后永远进不了库，实测 "22 小时零新增"。现在内容变了就放行，让它走自己的坑重建。
    if (prev && prev.content_hash === hash) return { ok: false, why: '已存在（内容没变）', coord: synced[source_id] }
    delete synced[source_id]
    meta.synced = synced
    saveMeta(meta)
    noTopic = true
  }

  const vocab = loadVocab()
  const feats = (features && features.length ? features : featsFromText(text, vocab))
  // ★ 2026-10-29 修：topic 优先用 source_id 派生的稳定键。
  //   老的 topicOf 会拼出「主人|能力|_」这种垃圾键，不同的事撞同一个 topic 就互相覆盖（实测一个坑被覆盖 15 次）。
  const topic = String(topicIn || '').trim() || (source_id ? 'src:' + source_id : '') || topicOf(text, aboutName) || ''
  const gate = gateOf(feats)
  const db = loadBlocks()
  const slots = loadSlots()
  const iso = toISO(at)

  // 找同 topic 的 head（一个坑只住一件事）。noTopic = 永远开新坑，绝不覆盖
  let target = null
  if (!noTopic && topic) {
    const tIdx = loadIdx('topic', {})
    for (const c of (tIdx[topic] || [])) {
      const b = db.blocks[c]
      if (b && (!b.head || b.head === c) && !b.superseded) { target = b; break }
    }
  }

  let coord = ''
  let kind = ''
  if (target) {
    const a = new Set(target.features || [])
    const b2 = new Set(feats)
    const inter = [...a].filter((x) => b2.has(x)).length
    const union = new Set([...a, ...b2]).size || 1
    const jac = inter / union
    if (jac >= 0.5) {
      // 微改：原地覆盖 ver+1
      coord = target.coord
      kind = 'OVERWRITE'
      const prev = { ...target }
      db.blocks[coord] = {
        ...target,
        ver: (target.ver || 1) + 1,
        content: text,
        features: feats,
        created_at: iso,
        verdict_at: iso,
        prev: coord + '@v' + (target.ver || 1),
        head: coord,
        kind,
        content_hash: hashOf(text),
        tokens: Math.ceil(text.length * 1.6),
      }
      appendEvent({
        type: 'BLOCK_OVERWRITE', coord, ts: iso,
        payload: { old: prev.content, new: text, old_hash: prev.content_hash, new_hash: hashOf(text) },
      })
    } else {
      // 大改：重建新坑，旧块内容不动，只把 head 指过来
      kind = 'REBUILD'
      coord = nextCoord(slots)
      db.blocks[coord] = {
        coord, ver: 1, content: text, features: feats, topic,
        gate_main: gate, gate_sub: [], result: 'ok', mood: '', confidence: 'mid',
        origin: target.origin || target.coord,
        origin_at: target.origin_at || target.created_at,
        line_id: target.line_id || target.origin || target.coord,
        head: coord, prev: target.coord, kind, source, source_id,
        created_at: iso, verdict_at: iso,
        content_hash: hashOf(text), tokens: Math.ceil(text.length * 1.6),
      }
      db.blocks[target.coord] = { ...target, head: coord }
      appendEvent({ type: 'BLOCK_REBUILD', coord, ts: iso, payload: { from: target.coord, new: text, why: '特征重合不足' } })
      appendEdge(db, coord, target.coord, '从旧说法变成新说法')
    }
  } else {
    // 全新的事
    kind = 'WRITE'
    coord = nextCoord(slots)
    const tpc = topic || ((aboutName || '未分类') + '|事实|' + text.slice(0, 10))
    db.blocks[coord] = {
      coord, ver: 1, content: text, features: feats, topic: tpc,
      gate_main: gate, gate_sub: [], result: 'ok', mood: '', confidence: 'mid',
      origin: coord, origin_at: iso, line_id: coord, head: coord, prev: '', kind,
      source, source_id, created_at: iso, verdict_at: iso,
      content_hash: hashOf(text), tokens: Math.ceil(text.length * 1.6),
    }
    appendEvent({ type: 'BLOCK_WRITE', coord, ts: iso, payload: { text, topic: tpc, features: feats } })
  }

  saveBlocks(db)
  saveSlots(slots)
  if (source_id) { meta.synced = meta.synced || {}; meta.synced[source_id] = coord; saveMeta(meta) }
  bumpIdx(db, coord)
  return { ok: true, coord, kind }
}

/**
 * ★ 首选入口：交给 AI 切块（2026-10-29）
 * 一段话（一次聊天、一条长记忆）→ 模型切成"一条一件事"，每块自带标题、特征、归属、类型。
 * 每块都走 noTopic：一件事一个坑，永远不会把别人的内容挤掉。
 * llm 不给/模型挂了 → 自动退到正则切句（不报错，只是粗一点）。
 */
export async function addBlocksFromText(text, { llm, aboutName = '', source = 'ai', sourceId = '', at = Date.now(), vocab, limit = 12 } = {}) {
  const v = vocab || loadVocab()
  const pieces = await segmentWithAI(text, { llm, aboutName, vocab: v, limit })
  const results = []
  if (pieces && pieces.length) {
    pieces.forEach((p, i) => {
      const r = addBlock({
        content: p.text,
        features: p.features && p.features.length ? p.features : featsFromText(p.text, v),
        topic: p.title ? 'topic:' + p.title : '',
        aboutName: p.who || aboutName,
        source,
        source_id: sourceId ? `${sourceId}#${i}` : '',
        at,
        noTopic: true,
      })
      results.push({ ...r, title: p.title, kind: p.kind, via: 'ai' })
    })
    return { via: 'ai', pieces: pieces.length, results }
  }
  // 降级：正则切句
  const fallback = splitSentences(text)
  fallback.forEach((piece, i) => {
    const r = addBlock({
      content: piece,
      features: featsFromText(piece, v),
      aboutName,
      source,
      source_id: sourceId ? `${sourceId}#${i}` : '',
      at,
      noTopic: true,
    })
    results.push({ ...r, via: 'regex' })
  })
  return { via: 'regex', pieces: fallback.length, results }
}

/** 把老 memory 的 items 搬成块（幂等；传 llm 就让 AI 切分，不传就按句子切） */
export async function ingestMemoryItems(items = [], { llm } = {}) {
  let added = 0
  let skipped = 0
  for (const it of items) {
    if (!it || !it.text) continue
    const r = await addBlocksFromText(it.text, {
      llm,
      aboutName: it.aboutName || '',
      source: 'memory',
      sourceId: 'mem:' + it.id,
      at: Number(it.at) || Date.now(),
    })
    for (const x of r.results) { if (x.ok) added += 1; else skipped += 1 }
  }
  return { added, skipped }
}

export { rebuildIndexes }
