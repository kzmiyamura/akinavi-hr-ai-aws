#!/usr/bin/env node
/**
 * quality_check.mjs — 品質チェック自動スクリプト
 *
 * 使い方:
 *   node scripts/quality_check.mjs              # 全チェック（直近1日）
 *   node scripts/quality_check.mjs --logs       # Edge Functionログ解析も含む（PAT必須）
 *   node scripts/quality_check.mjs --days 3     # 期間指定
 *   node scripts/quality_check.mjs --fetch-body # 問題人材のメール本文を表示（原因分析用）
 *   node scripts/quality_check.mjs --fetch-body --target noname   # 名前不明のみ
 *   node scripts/quality_check.mjs --fetch-body --target noexp    # 経験年数nullのみ
 *   node scripts/quality_check.mjs --fetch-body --target nopref   # 都道府県nullのみ
 *
 * 環境変数（.env.local から自動読み込み）:
 *   VITE_SUPABASE_URL         必須
 *   VITE_SUPABASE_ANON_KEY    必須
 *   SUPABASE_ACCESS_TOKEN     任意（Edge Functionログ解析に必要）
 *                             取得: https://supabase.com/dashboard/account/tokens
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// --- .env.local 読み込み ---
function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const PROJECT_REF = SUPABASE_URL?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です')
  process.exit(1)
}

const args = process.argv.slice(2)
const DAYS = parseInt(args.find((_, i) => args[i - 1] === '--days') ?? '1')
const INCLUDE_LOGS = args.includes('--logs')
const FETCH_BODY = args.includes('--fetch-body')
const FETCH_TARGET = args.find((_, i) => args[i - 1] === '--target') ?? 'all'
// --fetch-body 時に表示する本文の最大文字数
const BODY_MAX = 1500

const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()

// --- Supabase REST API ヘルパー ---
async function dbQuery(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  })
  if (!res.ok) throw new Error(`DB query failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function rpc(fn, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`RPC ${fn} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// --- Management API ログ取得 ---
async function fetchEdgeLogs(query, hours = 24) {
  if (!ACCESS_TOKEN || !PROJECT_REF) return null
  const end = new Date()
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
  const params = new URLSearchParams({
    product: 'edge-runtime',
    q: query,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
    limit: '500',
  })
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/analytics/endpoints/logs.all?${params}`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  )
  if (!res.ok) {
    console.warn(`  [logs API] ${res.status}: ${await res.text()}`)
    return null
  }
  const data = await res.json()
  return data.result ?? []
}

// --- 表示ヘルパー ---
const SEP = '─'.repeat(60)
const H = (title) => console.log(`\n${SEP}\n  ${title}\n${SEP}`)
const ok = (msg) => console.log(`  ✅ ${msg}`)
const warn = (msg) => console.log(`  ⚠️  ${msg}`)
const info = (msg) => console.log(`  ℹ️  ${msg}`)
const row = (label, val) => console.log(`  ${label.padEnd(30)} ${val}`)

console.log(`\n🔍 品質チェック開始（直近${DAYS}日 / since ${since.slice(0, 10)}）`)
if (!ACCESS_TOKEN) info('SUPABASE_ACCESS_TOKEN 未設定 → Edge Functionログ解析をスキップ')
if (!ACCESS_TOKEN) info('.env.local に SUPABASE_ACCESS_TOKEN=<PAT> を追加すると --logs が使えます')

// ============================================================
// 1. 人材抽出品質
// ============================================================
H('① 人材抽出品質（直近 ' + DAYS + ' 日）')
try {
  const candidates = await dbQuery(
    'candidates',
    `select=id,name,experience_years,desired_rate,created_at,data_env,skills,raw_profile` +
    `&created_at=gte.${since}&data_env=eq.prod&order=created_at.desc&limit=500`
  )

  const CAND_LIMIT = 500
  const total = candidates.length
  if (total >= CAND_LIMIT) warn(`取得件数が上限(${CAND_LIMIT})に達しています → --days を絞るか limit 増加を検討`)
  const noName = candidates.filter(c => !c.name || c.name === '不明' || c.name === '氏名不明').length
  const noExp = candidates.filter(c => c.experience_years == null).length
  const noPref = candidates.filter(c => !c.raw_profile?.prefecture).length
  const noRate = candidates.filter(c => !c.desired_rate).length
  const noStation = candidates.filter(c => !c.raw_profile?.nearestStation).length
  const noSkills = candidates.filter(c => !c.skills || c.skills.length === 0).length

  row('登録件数', `${total} 件`)
  row('名前不明', noName > 0 ? `⚠️  ${noName} 件` : `✅ 0 件`)
  row('経験年数 null', noExp > 0 ? `⚠️  ${noExp} 件` : `✅ 0 件`)
  row('都道府県 null', noPref > 0 ? `⚠️  ${noPref} 件` : `✅ 0 件`)
  row('希望単価 null', noRate > 0 ? `⚠️  ${noRate} 件` : `✅ 0 件`)
  row('最寄駅 null', noStation > 0 ? `⚠️  ${noStation} 件` : `✅ 0 件`)
  row('スキル 0 件', noSkills > 0 ? `⚠️  ${noSkills} 件` : `✅ 0 件`)

  // Wordスキル年数あり件数
  const withSkillYears = candidates.filter(c => {
    const sy = c.raw_profile?.skillYears
    return sy && Object.keys(sy).filter(k => k !== '_totalProjectMonths').length > 0
  }).length
  row('skillYears あり', `${withSkillYears} 件`)

  // 名前不明の件名リスト
  if (noName > 0) {
    console.log('\n  【名前不明の人材】')
    candidates.filter(c => !c.name || c.name === '不明' || c.name === '氏名不明')
      .forEach(c => console.log(`    - ${c.id.slice(0, 8)} created=${c.created_at.slice(0, 16)}`))
  }

  // ── --fetch-body: 問題人材のメール本文を表示 ──────────────────
  if (FETCH_BODY) {
    const targets = {
      noname: candidates.filter(c => !c.name || c.name === '不明' || c.name === '氏名不明'),
      noexp:  candidates.filter(c => c.experience_years == null),
      nopref: candidates.filter(c => !c.raw_profile?.prefecture),
    }
    const toShow = FETCH_TARGET === 'all'
      ? [...new Map([...targets.noname, ...targets.noexp, ...targets.nopref].map(c => [c.id, c])).values()].slice(0, 10)
      : (targets[FETCH_TARGET] ?? []).slice(0, 10)

    if (toShow.length === 0) {
      ok('fetch-body: 対象なし')
    } else {
      H(`📄 問題人材のメール本文（最大10件・各${BODY_MAX}字）`)
      for (const c of toShow) {
        const issues = [
          !c.name || c.name === '不明' ? '名前不明' : null,
          c.experience_years == null ? '経験年数null' : null,
          !c.raw_profile?.prefecture ? '都道府県null' : null,
        ].filter(Boolean).join(' / ')
        console.log(`\n${'─'.repeat(50)}`)
        console.log(`  ID: ${c.id.slice(0, 8)}  created: ${c.created_at.slice(0, 16)}  問題: ${issues}`)
        console.log(`  name: ${c.name ?? '(null)'}  exp: ${c.experience_years ?? '(null)'}  skills: ${(c.skills ?? []).slice(0, 5).join(',')}`)
        const text = c.raw_profile?.text ?? ''
        if (text) {
          console.log(`\n  【本文（先頭${BODY_MAX}字）】`)
          console.log(text.slice(0, BODY_MAX).split('\n').map(l => `    ${l}`).join('\n'))
          if (text.length > BODY_MAX) console.log(`    ...（残り${text.length - BODY_MAX}字省略）`)
        } else {
          console.log('  【本文なし】')
        }
      }
    }
  }
} catch (e) {
  warn(`人材クエリ失敗: ${e.message}`)
}

// ============================================================
// 2. AI ログ（モデル別・日次）
// ============================================================
H('② AIコスト監視（直近 ' + DAYS + ' 日）')
try {
  const LOG_LIMIT = 2000
  const logs = await dbQuery(
    'ai_logs',
    `select=model,created_at,duration_ms,error_message,status` +
    `&created_at=gte.${since}&order=created_at.desc&limit=${LOG_LIMIT}`
  )
  if (logs.length >= LOG_LIMIT) warn(`取得件数が上限(${LOG_LIMIT})に達しています → limit 増加を検討`)

  // モデル別集計
  const byModel = {}
  let errCount = 0
  for (const l of logs) {
    byModel[l.model] = (byModel[l.model] ?? 0) + 1
    if (l.error_message || l.status === 'error') errCount++
  }
  row('総呼び出し', `${logs.length} 件`)
  row('エラー', errCount > 0 ? `⚠️  ${errCount} 件` : `✅ 0 件`)
  for (const [model, cnt] of Object.entries(byModel).sort((a, b) => b[1] - a[1])) {
    row(`  ${model}`, `${cnt} 件`)
  }

  // 日次トレンド
  const byDay = {}
  for (const l of logs) {
    const day = l.created_at.slice(0, 10)
    byDay[day] = (byDay[day] ?? 0) + 1
  }
  console.log('\n  【日次呼び出し数（直近5日）】')
  Object.entries(byDay).sort().slice(-5).forEach(([day, cnt]) => {
    console.log(`    ${day}: ${cnt} 件`)
  })
} catch (e) {
  warn(`ai_logs クエリ失敗: ${e.message}`)
}

// ============================================================
// 3. skill_master 品質
// ============================================================
H('③ skill_master 品質')
try {
  // AI由来・未マッチエントリ
  const aiSrc = await dbQuery(
    'skill_master',
    `select=id,name,category,match_count,created_at` +
    `&source=eq.ai&match_count=eq.0&order=created_at.desc&limit=50`
  )
  row('AI由来・未マッチ', aiSrc.length > 0 ? `⚠️  ${aiSrc.length} 件（削除候補）` : `✅ 0 件`)
  if (aiSrc.length > 0) {
    console.log('\n  【削除候補（source=ai, match_count=0）】')
    aiSrc.slice(0, 10).forEach(s => console.log(`    - ${s.name} (${s.category})`))
    if (aiSrc.length > 10) console.log(`    ...他 ${aiSrc.length - 10} 件`)
  }

  // 30日未マッチ
  const stale = await dbQuery(
    'skill_master',
    `select=id,name,category,match_count` +
    `&match_count=eq.0&created_at=lt.${new Date(Date.now() - 30 * 86400000).toISOString()}&limit=50`
  )
  row('30日未マッチ', stale.length > 0 ? `⚠️  ${stale.length} 件` : `✅ 0 件`)

  // 総件数
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/skill_master?select=id`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, Prefer: 'count=exact' } }
  )
  const total = countRes.headers.get('content-range')?.split('/')[1] ?? '?'
  row('総登録数', `${total} 件`)
} catch (e) {
  warn(`skill_master クエリ失敗: ${e.message}`)
}

// ============================================================
// 4. GitHub Issue 確認
// ============================================================
H('④ GitHub Issue（open）')
try {
  const issRes = await fetch(
    `${SUPABASE_URL}/functions/v1/create-github-issue`,
    {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
    }
  )
  if (issRes.ok) {
    const issues = await issRes.json()
    const open = (Array.isArray(issues) ? issues : issues.issues ?? []).filter(i => i.state === 'open')
    row('open Issue', open.length > 0 ? `⚠️  ${open.length} 件` : `✅ 0 件`)
    open.slice(0, 5).forEach(i => console.log(`    #${i.number} ${i.title}`))
    if (open.length > 5) console.log(`    ...他 ${open.length - 5} 件`)
  } else {
    warn(`Issue API: ${issRes.status}`)
  }
} catch (e) {
  warn(`Issue クエリ失敗: ${e.message}`)
}

// ============================================================
// 5. Edge Function ログ解析（--logs + PAT が必要）
// ============================================================
if (INCLUDE_LOGS && ACCESS_TOKEN) {
  H('⑤ Edge Function ログ解析（直近24h）')

  // station_unmapped
  const unmapped = await fetchEdgeLogs('[station_unmapped]', 24 * DAYS)
  if (unmapped !== null) {
    const stations = unmapped
      .map(r => r.event_message?.match(/\[station_unmapped\]\s+(.+)/)?.[1])
      .filter(Boolean)
    const counts = {}
    stations.forEach(s => counts[s] = (counts[s] ?? 0) + 1)
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    row('未マッピング駅', sorted.length > 0 ? `⚠️  ${sorted.length} 種類` : `✅ 0 件`)
    if (sorted.length > 0) {
      console.log('\n  【station_master に追加候補】')
      sorted.slice(0, 15).forEach(([s, n]) => console.log(`    ${s} (${n}回)`))
    }
  }

  // Word処理サマリー
  const wordLogs = await fetchEdgeLogs('[Word] calcWordProjectMonths', 24 * DAYS)
  if (wordLogs !== null) {
    row('Word経験年数抽出', `${wordLogs.length} 件`)
    const nullLogs = await fetchEdgeLogs('日付.*件のみ → スキップ', 24 * DAYS)
    if (nullLogs?.length) warn(`  経験年数未取得: ${nullLogs.length} 件`)
  }

  // skill_master ログ
  const skillLogs = await fetchEdgeLogs('[skill_master] DB照合', 24 * DAYS)
  if (skillLogs !== null) {
    const totals = skillLogs.map(r => {
      const m = r.event_message?.match(/合計=(\d+)件/)
      return m ? parseInt(m[1]) : 0
    }).filter(n => n > 0)
    if (totals.length > 0) {
      const avg = Math.round(totals.reduce((s, n) => s + n, 0) / totals.length)
      row('スキル抽出 平均件数', `${avg} 件/メール`)
    }
  }

  // エラーログ
  const errLogs = await fetchEdgeLogs('ERROR', 24 * DAYS)
  if (errLogs !== null) {
    row('ERRORログ', errLogs.length > 0 ? `⚠️  ${errLogs.length} 件` : `✅ 0 件`)
    errLogs.slice(0, 5).forEach(r => console.log(`    ${r.timestamp?.slice(0, 16)} ${r.event_message?.slice(0, 80)}`))
  }
} else if (INCLUDE_LOGS && !ACCESS_TOKEN) {
  H('⑤ Edge Function ログ解析')
  warn('SUPABASE_ACCESS_TOKEN が未設定のためスキップ')
  info('.env.local に追加: SUPABASE_ACCESS_TOKEN=sbp_xxxx...')
  info('取得先: https://supabase.com/dashboard/account/tokens')
}

// ============================================================
// 完了
// ============================================================
console.log(`\n${'─'.repeat(60)}`)
console.log(`  品質チェック完了`)
if (!INCLUDE_LOGS) info('Edge Functionログを含める場合: node scripts/quality_check.mjs --logs')
console.log('')
