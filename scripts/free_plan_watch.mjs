#!/usr/bin/env node
/**
 * free_plan_watch.mjs — Free プランの壁に対する現在地を測る
 *
 *   node scripts/free_plan_watch.mjs            # 人が読む形
 *   node scripts/free_plan_watch.mjs --json     # 機械向け
 *   node scripts/free_plan_watch.mjs --quiet    # 警告が無ければ何も出さない（cron 向け）
 *
 * 見るもの（2026-09-30 に Pro → Free へ戻したため）:
 *   DB      500MB   ← pg_database_size。ここが正
 *   Storage 1GB     ← storage.objects の合計。ここが正
 *   egress  5GB/月  ← DB からは測れない。課金値はダッシュボードが正:
 *                      https://supabase.com/dashboard/org/fsodoektqqtvccdwnygv/usage
 *
 * 実行コストは数KB（集計値だけを返す SQL を1本）。本体は1行も引かない。
 * 毎回 ~/.akinavi_free_plan_state.json に追記し、増え方から「上限まであと何日」を出す。
 *
 * 終了コード: 0=余裕 / 1=警告(70%超) / 2=危険(85%超)
 */

import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SQL = resolve(ROOT, 'scripts/sql/free_plan_watch.sql')
const STATE = resolve(process.env.USERPROFILE || process.env.HOME, '.akinavi_free_plan_state.json')
const USAGE_URL = 'https://supabase.com/dashboard/org/fsodoektqqtvccdwnygv/usage'

// Free プランの壁
const LIMIT = {
  db: 500 * 1024 * 1024,
  storage: 1024 * 1024 * 1024,
  egress: 5 * 1024 * 1024 * 1024, // 参考。ここでは測れない
}
const WARN = 0.70
const CRIT = 0.85

const args = process.argv.slice(2)
const AS_JSON = args.includes('--json')
const QUIET = args.includes('--quiet')
const WANT_MAIL = args.includes('--mail')        // 警告以上のときだけ送る
const MAIL_ALWAYS = args.includes('--mail-always') // 状態にかかわらず送る（疎通確認・週次まとめ用）

// 送り先。環境変数 FREE_PLAN_ALERT_TO で上書きできる。
//
// ⚠ 既定が gmail ではなく yahoo なのには理由がある。
// Resend に独自ドメインを1つも登録していない（2026-09-30 実測: /domains は空）ため、
// 差出人は Resend の共有アドレス onboarding@resend.dev しか使えず、共有アドレスは
// **Resend アカウント本人のアドレス宛にしか送れない**（それ以外は 403 validation_error）。
// kzmiyamura@gmail.com に送りたい場合は Resend にドメインを登録して DNS を通し、
// MAIL_FROM をそのドメインのアドレスに変えること。そうすれば宛先の制限は外れる。
const MAIL_TO = process.env.FREE_PLAN_ALERT_TO || 'kzk_mymr@yahoo.co.jp'
const MAIL_FROM = process.env.FREE_PLAN_ALERT_FROM || 'AkiNavi 枠監視 <onboarding@resend.dev>'

/** .env.local を読む（RESEND_API_KEY はここにある） */
function envLocal(key) {
  if (process.env[key]) return process.env[key]
  const p = resolve(ROOT, '.env.local')
  if (!existsSync(p)) return undefined
  for (const raw of readFileSync(p, 'utf-8').split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq !== -1 && t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim()
  }
  return undefined
}

async function sendMail(subject, text) {
  const key = envLocal('RESEND_API_KEY')
  if (!key) return { ok: false, reason: 'RESEND_API_KEY が .env.local に無い' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, text }),
    })
    if (!res.ok) return { ok: false, reason: `Resend ${res.status} ${(await res.text()).slice(0, 200)}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}

// ---------------------------------------------------------------- 取得
function fetchSnapshot() {
  // Node 24 は .cmd シムを execFile で直接叩けない（EINVAL）ので shell 経由にする。
  // --output-format json は必須。端末から離れて（タスクスケジューラ等で）走ると
  // 既定が罫線つきの表になり、JSON として読めなくなる（2026-09-30 に実際に踏んだ）。
  const out = execFileSync(
    'npx',
    ['supabase', 'db', 'query', '--linked', '--output-format', 'json', '-f', `"${SQL}"`],
    { cwd: ROOT, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024, shell: true },
  )
  const start = out.indexOf('{')
  if (start === -1) throw new Error(`SQL の出力を解釈できない:\n${out.slice(0, 500)}`)
  const parsed = JSON.parse(out.slice(start))
  const row = parsed.rows?.[0]
  if (!row) throw new Error('rows が空')
  return typeof row.j === 'string' ? JSON.parse(row.j) : row.j
}

// ---------------------------------------------------------------- 履歴
function loadHistory() {
  if (!existsSync(STATE)) return []
  try {
    const h = JSON.parse(readFileSync(STATE, 'utf-8'))
    return Array.isArray(h) ? h : []
  } catch {
    return []
  }
}

function saveHistory(history, snap) {
  const next = [...history, { at: snap.at, db_bytes: snap.db_bytes, storage_bytes: snap.storage_bytes }]
  // 90件（≒3か月ぶん）で頭打ち
  writeFileSync(STATE, JSON.stringify(next.slice(-90), null, 0), 'utf-8')
  return next
}

/** 直近 maxDays 以内でいちばん古い記録と比べて 1日あたりの増分を出す */
function growthPerDay(history, key, maxDays = 14) {
  const now = Date.now()
  const old = history.find(h => (now - Date.parse(h.at)) / 86400000 <= maxDays)
  if (!old) return null
  const days = (now - Date.parse(old.at)) / 86400000
  if (days < 0.5) return null // 半日未満は誤差が大きすぎる
  return { perDay: (history.at(-1)[key] - old[key]) / days, days }
}

// ---------------------------------------------------------------- 表示
const mb = b => (b / 1048576).toFixed(1) + ' MB'
const pct = (b, lim) => Math.round((b / lim) * 100)

function level(ratio) {
  if (ratio >= CRIT) return { mark: '危険', code: 2 }
  if (ratio >= WARN) return { mark: '警告', code: 1 }
  return { mark: '余裕', code: 0 }
}

function bar(ratio) {
  const n = Math.min(20, Math.round(ratio * 20))
  return '█'.repeat(n) + '·'.repeat(20 - n)
}

function line(name, bytes, limit, growth) {
  const ratio = bytes / limit
  const lv = level(ratio)
  let tail = ''
  if (growth && growth.perDay > 0) {
    const daysLeft = (limit - bytes) / growth.perDay
    tail = daysLeft < 365
      ? `  +${mb(growth.perDay)}/日 → 上限まで約${Math.floor(daysLeft)}日`
      : `  +${mb(growth.perDay)}/日`
  } else if (growth) {
    tail = `  ${growth.perDay < 0 ? '減少中' : '横ばい'}（${growth.days.toFixed(1)}日で${mb(growth.perDay)}/日）`
  }
  return `${name.padEnd(8)} ${bar(ratio)} ${String(pct(bytes, limit)).padStart(3)}%  ${mb(bytes).padStart(9)} / ${mb(limit)}  [${lv.mark}]${tail}`
}

// ---------------------------------------------------------------- 本体
const snap = fetchSnapshot()
const history = saveHistory(loadHistory(), snap)

const dbRatio = snap.db_bytes / LIMIT.db
const stRatio = snap.storage_bytes / LIMIT.storage
const code = Math.max(level(dbRatio).code, level(stRatio).code)

if (AS_JSON) {
  console.log(JSON.stringify({
    ...snap,
    limits: LIMIT,
    db_pct: pct(snap.db_bytes, LIMIT.db),
    storage_pct: pct(snap.storage_bytes, LIMIT.storage),
    level: code,
  }))
  process.exit(code)
}

if (QUIET && code === 0) process.exit(0)

const gDb = growthPerDay(history, 'db_bytes')
const gSt = growthPerDay(history, 'storage_bytes')

const out = []
out.push(`Free プラン枠の現在地  ${new Date(snap.at).toLocaleString('ja-JP')}`)
out.push('─'.repeat(78))
out.push(line('DB', snap.db_bytes, LIMIT.db, gDb))
out.push(line('Storage', snap.storage_bytes, LIMIT.storage, gSt))
out.push(`egress   ${'·'.repeat(20)}   ?%  ここでは測れない / 5.0 GB  [要ダッシュボード]`)
out.push(`         ${USAGE_URL}`)
out.push('─'.repeat(78))

out.push('Storage の内訳:')
for (const b of snap.buckets) {
  out.push(`  ${b.bucket.padEnd(14)} ${mb(b.bytes).padStart(9)}  ${String(b.files).padStart(6)}件  最古 ${b.oldest}`)
}
out.push(`  直近24時間の流入 ${mb(snap.storage_in_24h)}`)

out.push('DB の大きい表:')
out.push('  ' + snap.top_tables.map(t => `${t.name} ${mb(t.bytes)}`).join(' / '))

out.push('保持の実績（最古の行）:')
out.push('  ' + Object.entries(snap.oldest).map(([k, v]) => `${k} ${v ?? '-'}`).join(' / '))

if (snap.dead_tuples > 50000) {
  out.push(`注意: 削除済みで未回収の行が ${snap.dead_tuples.toLocaleString()} 行ある（VACUUM 待ち。DB サイズが実態より大きく出る）`)
}

if (code > 0) {
  out.push('')
  out.push(code === 2
    ? '危険: 85% を超えた。掃除の間隔を縮めるか保持日数を見直すこと（保持日数を削るのは業務影響があるので独断で決めない）'
    : '警告: 70% を超えた。増え方を見て、掃除間隔（保持日数ではなく）から先に詰める')
}

const report = out.join('\n')
console.log(report)

// ---------------------------------------------------------------- メール
// --mail は「警告以上」＋「月曜の週次まとめ」だけ送る。
// 毎日届くと読まれなくなるが、まったく届かないと監視が死んでいても気付けない。
const isWeeklyDigest = new Date().getDay() === 1
if (MAIL_ALWAYS || (WANT_MAIL && (code > 0 || isWeeklyDigest))) {
  const label = code === 2 ? '【危険】' : code === 1 ? '【警告】' : '【定期】'
  const subject = `${label}AkiNavi Supabase Free 枠 — DB ${pct(snap.db_bytes, LIMIT.db)}% / Storage ${pct(snap.storage_bytes, LIMIT.storage)}%`
  const res = await sendMail(subject, `${report}\n\n---\nこのメールは ${ROOT} の scripts/free_plan_watch.mjs が送っています。\n止めるときはタスクスケジューラの AkinaviFreePlanWatch を無効にしてください。`)
  console.log(res.ok ? `メール送信: ${MAIL_TO}` : `メール送信できず: ${res.reason}`)
}

// fetch 直後に process.exit() すると Windows の libuv が
// 「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」で落ち、
// 終了コードが 127 に化ける（タスクスケジューラ側の判定が壊れる）。
process.exitCode = code
