/**
 * ローカル控え（既定 D:\akinavi-archive / 無ければ ~/akinavi-archive）を読む。
 * **本番は絶対に引かない。** 夜間健診が egress ゼロで回るための前提。
 *
 * 控えは archive_local.mjs が増分で貯めた JSONL。同じ id が複数日に出るので
 * **後の日を採る**（更新後の姿が正）。
 *
 * ## ⚠ 控えは「作成時の姿」しか持たない列がある
 *
 * `candidates` は **`created_at` の水位**で増分取得している（`_watermark.json`）。
 * つまり**1行は作成直後に1回しか撮られない**。その後 UPDATE で変わる列は、
 * 控えの中では**ずっと初期値のまま**になる。
 *
 * 判定してよい列: 取り込み時に決まるもの（`name` `skills` `from_company`
 *   `experience_years` `raw_profile.*` `duplicate_flag` …）
 * 判定してはいけない列: 後から変わるもの（`bookmarked` `box_status`
 *   `box_attempts` `merged_into` `updated_at` …）
 *
 * ここを混ぜると「0件だからバグ」という誤った所見を出す。
 * 1回目の実行で `bookmarked` について実際にやった。
 * **「引けなかった」を「無い」と書かない。**
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

/**
 * 「今の姿」のスナップショットを読む（`snapshot/<名前>.jsonl`）。
 *
 * ⚠ `loadTable` が読む日付別 JSONL は `created_at` の水位で撮っているので、
 *   **作成後に変わる列は初期値しか入っていない**。状態列（`box_status` など）を
 *   判定したいときはこちらを使う。archive_local.mjs の SNAPSHOTS が毎回上書きする。
 *
 * @returns {object[] | null} 無ければ null（**「0件」と区別すること**）
 */
export function loadSnapshot(name) {
  const ck = `snapshot:${name}`
  if (_cache.has(ck)) return _cache.get(ck)

  const root = archiveDir()
  if (!root) { _cache.set(ck, null); return null }

  const rows = []
  for (const p of [join(root, 'snapshot', `${name}.jsonl`), join(root, 'db', 'snapshot', `${name}.jsonl`)]) {
    if (!existsSync(p)) continue
    let text
    try { text = readFileSync(p, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* 壊れた行は飛ばす */ }
    }
    _cache.set(ck, rows)
    return rows
  }
  _cache.set(ck, null)
  return null
}

/**
 * マスタ系の控えを読む（`masters/<名前>.jsonl`）。
 *
 * `db/` 配下と違い**毎回まるごと撮り直している**ので、現在の値が入っている
 * （`skill_master` 955行・`app_config`・`station_master` など）。
 *
 * @returns {object[] | null} 無ければ null（**「0件」と区別すること**）
 */
export function loadMaster(name) {
  const ck = `master:${name}`
  if (_cache.has(ck)) return _cache.get(ck)

  const root = archiveDir()
  if (!root) { _cache.set(ck, null); return null }

  const p = join(root, 'masters', `${name}.jsonl`)
  if (!existsSync(p)) { _cache.set(ck, null); return null }
  let text
  try { text = readFileSync(p, 'utf8') } catch { _cache.set(ck, null); return null }

  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 壊れた行は飛ばす */ }
  }
  _cache.set(ck, rows)
  return rows
}

/**
 * `app_config` の値を控えから引く。無ければ `null`。
 *
 * ⚠ **未作成のキーは `null`。** 「その機能が無効」ではなく
 *   「コード側の既定で動いている」の意味（[[verify-dont-guess-db-keys]] と同じ罠）。
 */
export function appConfig(key) {
  const rows = loadMaster('app_config')
  if (!rows) return null
  const hit = rows.find((r) => r?.key === key)
  return hit ? hit.value ?? null : null
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
