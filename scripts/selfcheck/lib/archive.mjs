/**
 * ローカル控え（既定 D:\akinavi-archive / 無ければ ~/akinavi-archive）を読む。
 * **本番は絶対に引かない。** 夜間健診が egress ゼロで回るための前提。
 *
 * 控えは archive_local.mjs が増分で貯めた JSONL。同じ id が複数日に出るので
 * **後の日を採る**（更新後の姿が正）。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const CANDIDATES = [
  process.env.AKINAVI_ARCHIVE_DIR,
  'D:\\akinavi-archive',
  join(homedir(), 'akinavi-archive'),
].filter(Boolean)

/** 控えの場所。見つからなければ null（検出器は「測れない」を所見として出す） */
export function archiveDir() {
  for (const d of CANDIDATES) {
    const r = resolve(d)
    if (existsSync(join(r, 'db')) || existsSync(join(r, 'candidates'))) return r
  }
  return null
}

function tableDir(root, table) {
  for (const d of [join(root, 'db', table), join(root, table)]) {
    if (existsSync(d)) return d
  }
  // projects は単一ファイル（db/projects.jsonl）で置かれている
  return null
}

const _cache = new Map()

/**
 * 表を1つ読む。id（または keyCol）で重複を潰し、**後に出てきた行で上書きする**。
 *
 * @param {string} table 'candidates' | 'agent_companies' | 'ai_logs' | ...
 * @param {{key?: string}} [opt]
 * @returns {object[] | null} 控えに無ければ null
 */
export function loadTable(table, opt = {}) {
  const key = opt.key ?? (table === 'agent_companies' ? 'domain' : 'id')
  const ck = `${table}:${key}`
  if (_cache.has(ck)) return _cache.get(ck)

  const root = archiveDir()
  if (!root) { _cache.set(ck, null); return null }

  const files = []
  const dir = tableDir(root, table)
  if (dir) {
    for (const n of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) files.push(join(dir, n))
  } else {
    const single = join(root, 'db', `${table}.jsonl`)
    if (existsSync(single)) files.push(single)
  }
  if (!files.length) { _cache.set(ck, null); return null }

  const byKey = new Map()
  for (const f of files) {
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const k = row?.[key]
      if (k == null) continue
      byKey.set(k, row)   // 後の日で上書き＝最新の姿
    }
  }
  const rows = [...byKey.values()]
  _cache.set(ck, rows)
  return rows
}

/** prod だけに絞る（demo は検証用の作り物なので品質判定に混ぜない） */
export function prodOnly(rows) {
  return (rows ?? []).filter((r) => r.data_env == null || r.data_env === 'prod')
}

/**
 * 列の値分布。null と undefined は `'(null)'` に寄せる。
 * @returns {Map<string, number>}
 */
export function distribution(rows, field) {
  const m = new Map()
  for (const r of rows ?? []) {
    const v = r?.[field]
    const k = v == null ? '(null)' : typeof v === 'object' ? '(object)' : String(v)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

/** 控えがその列を持っているか。**持っていないことは「値が無い」ではない**ので区別する */
export function hasField(rows, field) {
  for (const r of rows ?? []) if (Object.prototype.hasOwnProperty.call(r, field)) return true
  return false
}
