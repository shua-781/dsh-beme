// 块库存储层（V3 · 40 号书卷四）
// 设计：只追加的事件日志 + 当前版本库 + 货位台账 + 派生索引
// 铁律：先写日志再写库（A1）；索引可重建（允许旧、不许超前）；原子写（临时文件 + rename）

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"

// 数据目录：默认 ./data/memory，可用环境变量 MEMORY_DIR 覆盖。
// （开源版不依赖任何宿主框架，自己就能跑。）
const ROOT = process.env.MEMORY_DIR || join(process.cwd(), "data", "memory")
const dataDir = (...parts) => join(ROOT, ...parts)

// ---------- 时间：一律 UTC+8 ISO 到秒（40 号书 §4.6）----------
const TZ = 8 * 3600 * 1000
const pad = (n, w = 2) => String(n).padStart(w, "0")

export function toISO(ms = Date.now()) {
  const d = new Date(Number(ms) + TZ)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
}

export function fromISO(s) {
  if (typeof s === "number") return s
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)
  if (!m) return Date.now()
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TZ
}

export function dayOf(msOrIso) {
  const ms = typeof msOrIso === "number" ? msOrIso : fromISO(msOrIso)
  const d = new Date(ms + TZ)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

// ---------- 路径与读写 ----------
export function B(...parts) {
  const p = dataDir("blocks", ...parts)
  if (parts.length === 0) mkdirSync(p, { recursive: true })
  return p
}
const FILE = {
  events: () => join(B(), "events.jsonl"),
  blocks: () => join(B(), "blocks.json"),
  slots: () => join(B(), "slots.json"),
  idx: (n) => join(B(), "idx", `${n}.json`),
  meta: () => join(B(), "meta.json"),
}

export function readJson(file, fallback) {
  try {
    let t = readFileSync(file, "utf8")
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
    return JSON.parse(t)
  } catch { return typeof fallback === "function" ? fallback() : fallback }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 1), "utf8")
  renameSync(tmp, file)
}

/** 只追加（A1 的物理前提）——事件日志绝不许被整文件重写 */
export function appendEvent(ev) {
  const f = FILE.events()
  mkdirSync(dirname(f), { recursive: true })
  appendFileSync(f, JSON.stringify(ev) + "\n", "utf8")
}

export function readEvents() {
  const f = FILE.events()
  if (!existsSync(f)) return []
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

// ---------- 库 / 台账 ----------
export function loadBlocks() { return readJson(FILE.blocks(), () => ({ blocks: {}, hist: [] })) }
export function saveBlocks(db) { writeJson(FILE.blocks(), db) }
export function loadSlots() { return readJson(FILE.slots(), () => ({ nextC: 1, used: {} })) }
export function saveSlots(s) { writeJson(FILE.slots(), s) }
export function loadMeta() { return readJson(FILE.meta(), () => ({}) ) }
export function saveMeta(m) { writeJson(FILE.meta(), m) }

/** 分配货位：位号只增不减、永不复用（40 号书 §4.3） */
export function nextCoord(slots) {
  while (slots.used[`1-1-${slots.nextC}`]) slots.nextC += 1
  const coord = `1-1-${slots.nextC}`
  slots.nextC += 1
  slots.used[coord] = 1
  return coord
}

// ---------- 索引 ----------
export const IDX = ["feat", "gate", "time", "topic", "chain", "origin"]
export function saveIdx(name, obj) { writeJson(FILE.idx(name), obj) }
export function loadIdx(name, fallback = {}) { return readJson(FILE.idx(name), fallback) }
export function idxExists() { return existsSync(FILE.idx("feat")) }

/** 全量重建六张物理索引（coord 就是 blocks.json 本身，edge/ding 暂无 rel 边不建）*/
export function rebuildIndexes(db) {
  const feat = {}, gate = {}, time = {}, topic = {}, chain = {}, origin = {}
  for (const [coord, b] of Object.entries(db.blocks || {})) {
    for (const f of b.features || []) (feat[f] = feat[f] || []).push(coord)
    for (const g of [b.gate_main, ...(b.gate_sub || [])].filter(Boolean)) (gate[g] = gate[g] || []).push(coord)
    const d = b.origin_at ? dayOf(b.origin_at) : dayOf(b.created_at)
    ;(time[d] = time[d] || []).push(coord)
    if (b.topic) (topic[b.topic] = topic[b.topic] || []).push(coord)
    const c = b.origin || coord
    ;(chain[c] = chain[c] || []).push(coord)
    ;(origin[b.origin || coord] = origin[b.origin || coord] || []).push(coord)
  }
  for (const [n, o] of Object.entries({ feat, gate, time, topic, chain, origin })) saveIdx(n, o)
  return { feat: Object.keys(feat).length, gate: Object.keys(gate).length, topic: Object.keys(topic).length, blocks: Object.keys(db.blocks || {}).length }
}
