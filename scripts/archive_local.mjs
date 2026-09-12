#!/usr/bin/env node
/**
 * 本番データの「ローカル控え」を増分で貯める。
 *
 *   node scripts/archive_local.mjs --dry-run     # 何件・何バイト引くかだけ出す（転送しない）
 *   node scripts/archive_local.mjs               # 取得して追記
 *   node scripts/archive_local.mjs --dir D:/akinavi-archive
 *
 * ■ なぜ要るか
 *   人材は7日（`candidate_retention_days`）で消える。消えたら二度と戻らないので、
 *   「先月と比べて抽出精度はどうか」「あの会社から来た人はどうだったか」を
 *   後から調べる手段が無い。控えがあれば、その手の調査で**本番を引かずに済む**
 *   （CLAUDE.md の egress 鉄則そのもの）。
 *
 * ■ 引く量を抑えるための取捨（2026-09-12 実測・1日あたり）
 *   raw_profile 丸ごと            5.5 MB
 *   attachmentText を除く         4.2 MB  ← これを採る
 *   本文も除く                    3.2 MB
 *   `attachmentText`（経歴書の中身・平均13KB）は落とす。原本は Storage にあり、
 *   後から再解析したいときは添付そのものを取りに行く方が確実。
 *   メール本文（`text`）は**残す**。抽出ロジックの回帰テストの素材そのもので、
 *   これが無いと控えを持つ意味が半減する。
 *   `ai_logs` は `raw_body` を落として metadata だけ（取りこぼし調査に使う）。
 *
 * ■ 追記の作法
 *   テーブルごとに「どこまで取ったか」を `_watermark.json` に持ち、次回はその続きから。
 *   同じ日を2度流しても行が重複しないよう、取得済みの id を見て弾く。
 *   出力は日付ごとの JSONL（`candidates/2026-09-12.jsonl`）。grep で読める形にしておく。
 *
 * ■ 保存先
 *   既定は `~/akinavi-archive`。外付けに移すときは `--dir` か
 *   環境変数 `AKINAVI_ARCHIVE_DIR` を変えるだけ（中身はそのままコピーすればよい）。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ENV_PATH = join(homedir(), '.akinavi_shadow.env')

function loadEnv(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    console.error(`env ファイルを読めません: ${path}\n${e.message}`)
    process.exit(1)
  }
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dirArg = args.indexOf('--dir') >= 0 ? args[args.indexOf('--dir') + 1] : null
const ARCHIVE_DIR = resolve(dirArg ?? process.env.AKINAVI_ARCHIVE_DIR ?? join(homedir(), 'akinavi-archive'))

const env = loadEnv(ENV_PATH)
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が env に見つかりません')
  process.exit(1)
}

/**
 * 1回に引く行数。
 * PostgREST の上限は 1000 だが、candidates は raw_profile から十数個の JSON パスを
 * 取り出すので **1000 行だと statement timeout になる**（2026-09-12 実測）。
 * 表ごとに現実的な値を持たせる。
 */
const DEFAULT_PAGE = 1000

/**
 * 取得対象。`select` は**必要な列だけ**を明示する。
 * `*` にすると raw_profile の重い項目まで毎日引くことになる。
 */
const TARGETS = [
  {
    name: 'candidates',
    table: 'candidates',
    order: 'created_at',
    // JSON パスを十数個取り出すので、1000 行だと statement timeout になる
    page: 200,
    // raw_profile は attachmentText を除いて丸ごと持つ。
    // PostgREST は「JSON の一部を除く」ができないので、要る項目を列挙する。
    select: [
      'id', 'name', 'created_at', 'updated_at', 'data_env',
      'skills', 'experience_years', 'desired_rate', 'from_company',
      'duplicate_flag', 'merged_into', 'bookmarked',
      'resume_url', 'drive_url', 'box_url',
      'rp_text:raw_profile->>text',
      'rp_subject:raw_profile->>subject',
      'rp_from:raw_profile->>from',
      'rp_received:raw_profile->>emailReceivedAt',
      'rp_skillYears:raw_profile->skillYears',
      'rp_skillsByCategory:raw_profile->skillsByCategory',
      'rp_roles:raw_profile->roles',
      'rp_industries:raw_profile->industries',
      'rp_prefecture:raw_profile->>prefecture',
      'rp_nearestStation:raw_profile->>nearestStation',
      'rp_availableRegions:raw_profile->availableRegions',
      'rp_commercialFlow:raw_profile->>commercialFlow',
      'rp_employmentType:raw_profile->>employmentType',
      'rp_nationality:raw_profile->>nationality',
      'rp_age:raw_profile->age',
      'rp_gender:raw_profile->>gender',
      'rp_agentComment:raw_profile->>agentComment',
      'rp_selfPR:raw_profile->>selfPR',
      'rp_remoteAvailable:raw_profile->remoteAvailable',
      'rp_hakenOk:raw_profile->hakenOk',
      'rp_roleLevels:raw_profile->_roleLevels',
    ].join(','),
  },
  {
    name: 'ai_logs',
    table: 'ai_logs',
    order: 'created_at',
    // raw_body は candidates 側の本文とほぼ重複するので落とす。
    // 取りこぼし調査（linked_id が null＝登録されなかったメール）に使う metadata だけ残す
    select: [
      'id', 'type', 'model', 'from_address', 'subject', 'status',
      'error_message', 'duration_ms', 'prompt_length', 'linked_id', 'created_at',
    ].join(','),
  },
  {
    name: 'agent_companies',
    table: 'agent_companies',
    order: 'updated_at',
    key: 'domain', // この表だけ主キーが id ではない
    select: '*',
  },
]

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

/**
 * カーソル方式で1ページ引く。
 * OFFSET は後ろのページほど遅くなり、大きい表では必ずタイムアウトに当たる。
 * 並び順の列そのものを条件にすれば、何ページ目でも同じ速さで返る。
 * 同じ時刻の行を取りこぼさないよう `gte` で引き、重複は id で弾く。
 */
async function fetchPage(table, select, orderCol, cursor, page) {
  const params = new URLSearchParams()
  params.set('select', select)
  params.set('order', `${orderCol}.asc`)
  params.set('limit', String(page))
  if (cursor) params.set(orderCol, `gte.${cursor}`)
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`${table} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return { rows: JSON.parse(text), bytes: Buffer.byteLength(text) }
}

/** 本体を受け取らずに件数だけ数える（HEAD + count=exact） */
async function countRows(table, orderCol, since, keyCol) {
  const params = new URLSearchParams()
  // 主キーは表ごとに違う（agent_companies は domain）。`id` 固定にすると
  // 列が無い表で 0 件として通り過ぎる
  params.set('select', keyCol)
  if (since) params.set(orderCol, `gt.${since}`)
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'HEAD',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
    signal: AbortSignal.timeout(60000),
  })
  const cr = res.headers.get('content-range') ?? ''
  const m = cr.match(/\/(\d+)$/)
  return m ? Number(m[1]) : 0
}

mkdirSync(ARCHIVE_DIR, { recursive: true })
const wmPath = join(ARCHIVE_DIR, '_watermark.json')
const watermark = readJson(wmPath, {})

console.log(`保存先: ${ARCHIVE_DIR}`)
if (dryRun) console.log('（--dry-run: 件数だけ数えます。本体は転送しません）\n')

let totalBytes = 0
let totalRows = 0

for (const t of TARGETS) {
  const since = watermark[t.name] ?? null
  const keyCol = t.key ?? 'id'
  const pending = await countRows(t.table, t.order, since, keyCol)
  if (dryRun) {
    console.log(`${t.name.padEnd(16)} 未取得 ${String(pending).padStart(6)} 件` +
      (since ? `（${since} より後）` : '（初回・全件）'))
    totalRows += pending
    continue
  }
  if (pending === 0) {
    console.log(`${t.name.padEnd(16)} 新しい行なし`)
    continue
  }

  // 同じ行を二重に書かないための取得済み id。ファイルが増えても行数ぶんしか持たないので軽い
  const seenPath = join(ARCHIVE_DIR, t.name, '_ids.txt')
  const seen = new Set(existsSync(seenPath) ? readFileSync(seenPath, 'utf8').split('\n').filter(Boolean) : [])

  mkdirSync(join(ARCHIVE_DIR, t.name), { recursive: true })
  const page = t.page ?? DEFAULT_PAGE
  let cursor = since
  let wrote = 0
  let newest = since
  for (;;) {
    const { rows, bytes } = await fetchPage(t.table, t.select, t.order, cursor, page)
    totalBytes += bytes
    if (rows.length === 0) break
    const byDay = new Map()
    let fresh = 0
    for (const row of rows) {
      const id = String(row[keyCol])
      if (seen.has(id)) continue
      seen.add(id)
      fresh++
      const day = String(row[t.order] ?? '').slice(0, 10) || 'unknown'
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(JSON.stringify(row))
      if (!newest || String(row[t.order]) > newest) newest = String(row[t.order])
      wrote++
    }
    for (const [day, lines] of byDay) {
      appendFileSync(join(ARCHIVE_DIR, t.name, `${day}.jsonl`), lines.join('\n') + '\n', 'utf8')
    }
    process.stdout.write(`\r${t.name.padEnd(16)} ${wrote} 件…`)
    const last = String(rows[rows.length - 1][t.order] ?? '')
    // 1ページ全部が取得済み＝同じ時刻の行で足踏みしている。ここで止めないと無限ループ
    if (rows.length < page || !last || (fresh === 0 && last === cursor)) break
    cursor = last
  }
  writeFileSync(seenPath, [...seen].join('\n'), 'utf8')
  if (newest) watermark[t.name] = newest
  totalRows += wrote
  console.log(`\r${t.name.padEnd(16)} ${wrote} 件を追記（次回は ${newest} より後）`)
}

if (!dryRun) {
  writeFileSync(wmPath, JSON.stringify(watermark, null, 2), 'utf8')
  const mb = (totalBytes / 1024 / 1024).toFixed(1)
  console.log(`\n合計 ${totalRows} 件 / 受信 ${mb} MB`)
} else {
  console.log(`\n合計 ${totalRows} 件が未取得`)
}

/** 保存先の合計サイズを出す（控えが太りすぎていないかの確認用） */
function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else total += statSync(p).size
    }
  }
  try { walk(dir) } catch { /* ignore */ }
  return total
}
if (!dryRun) {
  console.log(`控えの合計: ${(dirSize(ARCHIVE_DIR) / 1024 / 1024).toFixed(1)} MB`)
}
