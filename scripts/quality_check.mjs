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
  const escaped = query.replace(/'/g, "''")
  const sql = `SELECT timestamp, event_message, metadata FROM function_logs WHERE event_message LIKE '%${escaped}%' ORDER BY timestamp DESC LIMIT 500`
  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
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
// 2. AI ログ（モデル別・日次・異常監視・コスト）
// ============================================================
H('② AIコスト監視 / 異常監視（直近14日）')
let aiLogs14 = []
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const LOG_LIMIT = 5000
  aiLogs14 = await dbQuery(
    'ai_logs',
    `select=model,created_at,duration_ms,error_message,status` +
    `&created_at=gte.${since14}&order=created_at.desc&limit=${LOG_LIMIT}`
  )
  if (aiLogs14.length >= LOG_LIMIT) warn(`取得件数が上限(${LOG_LIMIT})に達しています → limit 増加を検討`)

  // ── モデル別集計（total / errors / avg_ms）──────────────
  const byModel = {}
  for (const l of aiLogs14) {
    const m = l.model ?? 'unknown'
    if (!byModel[m]) byModel[m] = { cnt: 0, err: 0, totalMs: 0 }
    byModel[m].cnt++
    if (l.error_message || l.status === 'error') byModel[m].err++
    if (l.duration_ms) byModel[m].totalMs += l.duration_ms
  }
  const totalCalls = aiLogs14.length
  const totalErr = Object.values(byModel).reduce((s, v) => s + v.err, 0)
  row('総呼び出し', `${totalCalls} 件`)
  row('総エラー', totalErr > 0 ? `⚠️  ${totalErr} 件` : `✅ 0 件`)
  console.log('\n  【モデル別: total / errors / avg_ms】')
  for (const [model, v] of Object.entries(byModel).sort((a, b) => b[1].cnt - a[1].cnt)) {
    const errRate = totalCalls > 0 ? Math.round(100 * v.err / v.cnt) : 0
    const avgMs = v.cnt > 0 ? Math.round(v.totalMs / v.cnt) : 0
    const errMark = errRate > 10 ? ' ⚠️' : ''
    console.log(`    ${model.padEnd(30)} ${String(v.cnt).padStart(5)}件  err:${v.err}(${errRate}%)${errMark}  avg:${avgMs}ms`)
  }

  // ── 日次トレンド（gemini / groq / cerebras / no-ai）──────
  const byDay = {}
  for (const l of aiLogs14) {
    const day = l.created_at.slice(0, 10)
    if (!byDay[day]) byDay[day] = { gemini: 0, geminiErr: 0, groq: 0, cerebras: 0, bedrock: 0, noAi: 0 }
    const m = (l.model ?? '').toLowerCase()
    const isErr = !!(l.error_message || l.status === 'error')
    if (m.includes('gemini'))                          { byDay[day].gemini++; if (isErr) byDay[day].geminiErr++ }
    else if (m.includes('groq') || m.includes('llama')) byDay[day].groq++
    else if (m.includes('cerebras') || m === 'llama3.1-8b') byDay[day].cerebras++
    else if (m.includes('bedrock'))                    byDay[day].bedrock++
    else if (m === 'no-ai')                            byDay[day].noAi++
  }
  console.log('\n  【日次内訳（直近7日）gemini / groq / cerebras / bedrock / no-ai】')
  Object.entries(byDay).sort().slice(-7).forEach(([day, v]) => {
    const bedrockMark = v.bedrock > 0 ? ` ⚠️Bedrock:${v.bedrock}` : ''
    const geminiMark = v.gemini > 1000 ? ' ⚠️無料枠圧迫' : ''
    console.log(`    ${day}: gemini=${v.gemini}(err=${v.geminiErr})${geminiMark}  groq=${v.groq}  cerebras=${v.cerebras}${bedrockMark}  no-ai=${v.noAi}`)
  })

  // ── フォールバック多発チェック ────────────────────────────
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString()
  const recent7 = aiLogs14.filter(l => l.created_at >= since7)
  const geminiTotal7 = recent7.filter(l => (l.model ?? '').toLowerCase().includes('gemini')).length
  const groqTotal7 = recent7.filter(l => {
    const m = (l.model ?? '').toLowerCase()
    return m.includes('groq') || (m.includes('llama') && !m.includes('cerebras') && m !== 'llama3.1-8b')
  }).length
  if (geminiTotal7 > groqTotal7 * 2 && geminiTotal7 > 10) {
    warn(`フォールバック多発疑い: 直近7日 gemini=${geminiTotal7} groq=${groqTotal7}（Cerebras/Groq枯渇の可能性）`)
  }

  // ── Gemini クレジットエラー確認 ────────────────────────────
  const geminiErrors = aiLogs14.filter(l =>
    (l.model ?? '').toLowerCase().includes('gemini') && l.error_message
  )
  if (geminiErrors.length > 0) {
    const errGroups = {}
    for (const l of geminiErrors) {
      const key = (l.error_message ?? '').slice(0, 80)
      errGroups[key] = (errGroups[key] ?? 0) + 1
    }
    console.log('\n  【Gemini エラー内訳（直近14日・上位5種）】')
    Object.entries(errGroups).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([msg, cnt]) => {
      const mark = msg.includes('prepayment') ? ' ⚠️ クレジット枯渇!' : msg.includes('429') ? ' ⚠️ 無料枠超過' : ''
      console.log(`    ${cnt}回: ${msg}${mark}`)
    })
  }
} catch (e) {
  warn(`ai_logs クエリ失敗: ${e.message}`)
}

// ── submissions 集計（auto-match 処理量・重複スコアリング）──
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const subs = await dbQuery(
    'submissions',
    `select=candidate_id,project_id,created_at` +
    `&data_env=eq.prod&created_at=gte.${since14}&order=created_at.desc&limit=3000`
  )
  // 日次集計
  const subByDay = {}
  for (const s of subs) {
    const day = s.created_at.slice(0, 10)
    if (!subByDay[day]) subByDay[day] = { cnt: 0, candidates: new Set(), projects: new Set() }
    subByDay[day].cnt++
    subByDay[day].candidates.add(s.candidate_id)
    subByDay[day].projects.add(s.project_id)
  }
  console.log('\n  【submissions 日次生成数（直近7日）】')
  Object.entries(subByDay).sort().slice(-7).forEach(([day, v]) => {
    const surge = v.cnt > 200 ? ' ⚠️ 急増（手動全件マッチング？）' : ''
    console.log(`    ${day}: ${v.cnt}件  候補者:${v.candidates.size}人  案件:${v.projects.size}件${surge}`)
  })
  // 重複スコアリング検出
  const pairCount = {}
  for (const s of subs) {
    const key = `${s.candidate_id}__${s.project_id}`
    pairCount[key] = (pairCount[key] ?? 0) + 1
  }
  const dupes = Object.entries(pairCount).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
  if (dupes.length > 0) {
    warn(`重複スコアリング: ${dupes.length} ペア`)
    dupes.slice(0, 5).forEach(([key, n]) => {
      const [cid, pid] = key.split('__')
      console.log(`    candidate:${cid.slice(0, 8)} × project:${pid.slice(0, 8)} → ${n}件`)
    })
  } else {
    ok('重複スコアリングなし')
  }
} catch (e) {
  warn(`submissions クエリ失敗: ${e.message}`)
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

  // ── Excel 抽出ログ ──────────────────────────────────────────
  console.log(`\n  【Excel 抽出ログ（直近 ${DAYS} 日）】`)
  const excelRawLogs  = await fetchEdgeLogs('[Excel-raw]', 24 * DAYS)
  const syOkLogs      = await fetchEdgeLogs('[skillYears]', 24 * DAYS)
  const syMissLogs    = await fetchEdgeLogs('[skillYears-miss]', 24 * DAYS)

  if (excelRawLogs !== null) {
    row('  Excel 処理数（[Excel-raw]）', `${excelRawLogs.length} 件`)
  }
  if (syOkLogs !== null) {
    // 成功件数と抽出スキル数の集計
    const keyCounts = syOkLogs.map(r => {
      const m = r.event_message?.match(/keys=\[([^\]]*)\]/)
      return m ? m[1].split(',').filter(Boolean).length : 0
    })
    const avgKeys = keyCounts.length
      ? Math.round(keyCounts.reduce((s, n) => s + n, 0) / keyCounts.length)
      : 0
    row('  skillYears 取得成功', `✅ ${syOkLogs.length} 件（平均 ${avgKeys} スキル）`)
  }
  if (syMissLogs !== null) {
    row('  skillYears 取得失敗 [miss]', syMissLogs.length > 0 ? `⚠️  ${syMissLogs.length} 件` : `✅ 0 件`)
    if (syMissLogs.length > 0) {
      console.log('\n  【[skillYears-miss] サンプル（未対応フォーマット診断）】')
      // head= を含む行を最大5件表示
      const samples = syMissLogs.filter(r => r.event_message?.includes('head=')).slice(0, 5)
      samples.forEach(r => {
        const ts = r.timestamp?.slice(0, 16) ?? ''
        // head= 以降を抽出（表示は150字まで）
        const head = r.event_message?.match(/head=(.+)/s)?.[1]?.slice(0, 150) ?? r.event_message?.slice(0, 150)
        console.log(`    ${ts}  ${head}`)
      })
      if (syMissLogs.length > 5) {
        info(`    ... 他 ${syMissLogs.length - 5} 件。extractSkillYearsFromSheetData の追加対応を検討`)
      }
    }
  }
  if (excelRawLogs === null && syOkLogs === null && syMissLogs === null) {
    info('  Excel ログ取得に失敗しました')
  }
} else if (INCLUDE_LOGS && !ACCESS_TOKEN) {
  H('⑤ Edge Function ログ解析')
  warn('SUPABASE_ACCESS_TOKEN が未設定のためスキップ')
  info('.env.local に追加: SUPABASE_ACCESS_TOKEN=sbp_xxxx...')
  info('取得先: https://supabase.com/dashboard/account/tokens')
}

// ============================================================
// 6. 年齢・性別取得率（直近14日）
// ============================================================
H('⑥ 年齢・性別取得率（直近14日）')
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const cands14 = await dbQuery(
    'candidates',
    `select=id,name,raw_profile,created_at` +
    `&created_at=gte.${since14}&data_env=eq.prod&order=created_at.desc&limit=500`
  )
  if (cands14.length === 0) {
    ok('対象データなし')
  } else {
    const total = cands14.length
    const ageFilled = cands14.filter(c => c.raw_profile?.age != null).length
    const genderFilled = cands14.filter(c => c.raw_profile?.gender != null).length
    const ageRate = Math.round(100 * ageFilled / total)
    const genderRate = Math.round(100 * genderFilled / total)
    row('対象件数', `${total} 件`)
    row('年齢 取得率', ageRate < 50 ? `⚠️  ${ageFilled}/${total} (${ageRate}%)` : `✅ ${ageFilled}/${total} (${ageRate}%)`)
    row('性別 取得率', genderRate < 50 ? `⚠️  ${genderFilled}/${total} (${genderRate}%)` : `✅ ${genderFilled}/${total} (${genderRate}%)`)
    if (ageRate < 80 || genderRate < 80) {
      const samples = cands14.filter(c =>
        (c.raw_profile?.age == null || c.raw_profile?.gender == null) &&
        c.name && c.name !== '不明'
      ).slice(0, 5)
      if (samples.length > 0) {
        console.log('\n  【未取得サンプル（最大5件）】')
        for (const c of samples) {
          console.log(`    ID:${c.id.slice(0, 8)}  name:${c.name}  age:${c.raw_profile?.age ?? 'null'}  gender:${c.raw_profile?.gender ?? 'null'}`)
          const body = (c.raw_profile?.text ?? '').slice(0, 150).replace(/\n/g, ' ')
          if (body) console.log(`    本文先頭: ${body}`)
        }
      }
    } else {
      ok('年齢・性別取得率は正常（80%以上）')
    }
  }
} catch (e) {
  warn(`年齢・性別チェック失敗: ${e.message}`)
}

// ============================================================
// 7. フィールド充足率（国籍・自己PR・agentComment、直近14日）
// ============================================================
H('⑦ フィールド充足率（直近14日）')
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const cands14f = await dbQuery(
    'candidates',
    `select=id,name,raw_profile,created_at` +
    `&created_at=gte.${since14}&data_env=eq.prod&order=created_at.desc&limit=500`
  )
  if (cands14f.length === 0) {
    ok('対象データなし')
  } else {
    const total = cands14f.length
    const natFilled = cands14f.filter(c => c.raw_profile?.nationality != null).length
    const prFilled = cands14f.filter(c => c.raw_profile?.selfPR != null).length
    const agentFilled = cands14f.filter(c => c.raw_profile?.agentComment != null).length
    const natPct = Math.round(100 * natFilled / total)
    const prPct = Math.round(100 * prFilled / total)
    const agentPct = Math.round(100 * agentFilled / total)
    row('対象件数', `${total} 件`)
    row('nationality 充足率', `${natFilled}/${total} (${natPct}%)`)
    row('selfPR 充足率', prPct < 20 ? `⚠️  ${prFilled}/${total} (${prPct}%)` : `${prFilled}/${total} (${prPct}%)`)
    row('agentComment 充足率', agentPct < 20 ? `⚠️  ${agentFilled}/${total} (${agentPct}%)` : `${agentFilled}/${total} (${agentPct}%)`)
    if (prPct < 20 || agentPct < 20) {
      const samples = cands14f.filter(c =>
        (c.raw_profile?.selfPR == null || c.raw_profile?.agentComment == null) &&
        c.name && c.name !== '不明'
      ).slice(0, 3)
      if (samples.length > 0) {
        console.log('\n  【未取得サンプル（最大3件）】')
        for (const c of samples) {
          console.log(`    ID:${c.id.slice(0, 8)}  name:${c.name}  selfPR:${c.raw_profile?.selfPR != null ? 'あり' : 'null'}  agentComment:${c.raw_profile?.agentComment != null ? 'あり' : 'null'}`)
          const body = (c.raw_profile?.text ?? '').slice(0, 150).replace(/\n/g, ' ')
          if (body) console.log(`    本文先頭: ${body}`)
        }
      }
    }
  }
} catch (e) {
  warn(`フィールド充足率チェック失敗: ${e.message}`)
}

// ============================================================
// 8. 名前汚染チェック（直近14日）
// ============================================================
H('⑧ 名前汚染チェック（直近14日）')
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const cands14n = await dbQuery(
    'candidates',
    `select=id,name,created_at,raw_profile` +
    `&created_at=gte.${since14}&data_env=eq.prod&order=created_at.desc&limit=500`
  )
  const CONTAMINATED_RE = /男性|女性|男$|女$|\d+歳|\d+才|[（(]\d+[）)]|重複|NULL/
  const dirty = cands14n.filter(c => c.name && CONTAMINATED_RE.test(c.name))
  if (dirty.length === 0) {
    ok('名前汚染なし')
  } else {
    warn(`名前汚染: ${dirty.length} 件`)
    dirty.slice(0, 10).forEach(c => {
      const body = (c.raw_profile?.text ?? '').slice(0, 100).replace(/\n/g, ' ')
      console.log(`    ID:${c.id.slice(0, 8)}  name: "${c.name}"  本文先頭: ${body}`)
    })
  }
} catch (e) {
  warn(`名前汚染チェック失敗: ${e.message}`)
}

// ============================================================
// 9. 非人材メール混入チェック（直近14日）
// ============================================================
H('⑨ 非人材メール混入チェック（直近14日）')
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const cands14m = await dbQuery(
    'candidates',
    `select=id,name,created_at,raw_profile` +
    `&created_at=gte.${since14}&data_env=eq.prod&order=created_at.desc&limit=500`
  )
  const BUSI_SUBJ_RE = /契約|確認|ご連絡|報告|請求|お知らせ|案内|返信|RE:|Fwd:/i
  const BUSI_BODY_RE = /契約|請求|報告/i
  const mixed = cands14m.filter(c => {
    const subj = c.raw_profile?.subject ?? ''
    const body = c.raw_profile?.text ?? ''
    return BUSI_SUBJ_RE.test(subj) || ((!c.name || c.name === '不明') && BUSI_BODY_RE.test(body))
  })
  if (mixed.length === 0) {
    ok('非人材メール混入なし')
  } else {
    warn(`非人材疑い: ${mixed.length} 件`)
    mixed.slice(0, 10).forEach(c => {
      const subj = c.raw_profile?.subject ?? '(件名なし)'
      const from = c.raw_profile?.from ?? ''
      const body = (c.raw_profile?.text ?? '').slice(0, 80).replace(/\n/g, ' ')
      console.log(`    ID:${c.id.slice(0, 8)}  name:"${c.name}"  from:${from}`)
      console.log(`      件名: ${subj}`)
      console.log(`      本文: ${body}`)
    })
  }
} catch (e) {
  warn(`非人材混入チェック失敗: ${e.message}`)
}

// ============================================================
// 10. 複数人メール分割失敗チェック（直近14日）
// ============================================================
H('⑩ 複数人メール分割失敗チェック（直近14日）')
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const cands14s = await dbQuery(
    'candidates',
    `select=id,name,created_at,raw_profile` +
    `&created_at=gte.${since14}&data_env=eq.prod&order=created_at.desc&limit=500`
  )
  // from_email × 日付でグループ化
  const groups = {}
  for (const c of cands14s) {
    const fromEmail = c.raw_profile?.from ?? 'unknown'
    const day = c.created_at.slice(0, 10)
    const key = `${fromEmail}__${day}`
    if (!groups[key]) groups[key] = { from: fromEmail, day, records: [] }
    groups[key].records.push(c)
  }
  // 登録1件 & 本文2000字超
  const suspects = Object.values(groups).filter(g => {
    if (g.records.length !== 1) return false
    const bodyLen = (g.records[0].raw_profile?.text ?? '').length
    return bodyLen > 2000
  }).sort((a, b) => (b.records[0].raw_profile?.text?.length ?? 0) - (a.records[0].raw_profile?.text?.length ?? 0))
  if (suspects.length === 0) {
    ok('複数人メール分割失敗の疑いなし')
  } else {
    warn(`分割失敗疑い: ${suspects.length} 件（1送信元・同日・本文2000字超）`)
    suspects.slice(0, 5).forEach(g => {
      const c = g.records[0]
      const bodyLen = (c.raw_profile?.text ?? '').length
      console.log(`    ID:${c.id.slice(0, 8)}  from:${g.from}  day:${g.day}  本文長:${bodyLen}字`)
    })
  }
} catch (e) {
  warn(`分割失敗チェック失敗: ${e.message}`)
}

// ============================================================
// 11. skillYears 取得率チェック（直近14日）
// ============================================================
H('⑪ skillYears 取得率（直近14日）')
try {
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString()
  const cands14sy = await dbQuery(
    'candidates',
    `select=id,name,skills,drive_url,resume_url,raw_profile,created_at` +
    `&created_at=gte.${since14}&data_env=eq.prod&order=created_at.desc&limit=500`
  )
  if (cands14sy.length === 0) {
    ok('対象データなし')
  } else {
    const total = cands14sy.length
    const withSY = cands14sy.filter(c => {
      const sy = c.raw_profile?.skillYears
      return sy && typeof sy === 'object' && Object.keys(sy).filter(k => k !== '_totalProjectMonths').length > 0
    }).length
    const hasDrive = cands14sy.filter(c => c.drive_url || c.resume_url).length
    const driveWithSY = cands14sy.filter(c => {
      const sy = c.raw_profile?.skillYears
      const hasLink = c.drive_url || c.resume_url
      return hasLink && sy && Object.keys(sy).filter(k => k !== '_totalProjectMonths').length > 0
    }).length
    const syRate = Math.round(100 * withSY / total)
    row('対象件数', `${total} 件`)
    row('skillYears 取得率', syRate < 10 ? `⚠️  ${withSY}/${total} (${syRate}%)` : `${withSY}/${total} (${syRate}%)`)
    row('Drive/resumeリンクあり', `${hasDrive} 件`)
    row('  うち skillYears あり', hasDrive > 0 ? `${driveWithSY}/${hasDrive}` : '-')
    if (hasDrive > 0 && driveWithSY < hasDrive * 0.2) {
      warn('Drive/resumeリンクあり候補者の skillYears 取得率が低い（Excel フォーマット未対応の可能性）')
      const samples = cands14sy.filter(c => {
        const sy = c.raw_profile?.skillYears
        const hasLink = c.drive_url || c.resume_url
        const skillCount = Array.isArray(c.skills) ? c.skills.length : 0
        return hasLink && !(sy && Object.keys(sy).filter(k => k !== '_totalProjectMonths').length > 0) && skillCount >= 5
      }).slice(0, 3)
      if (samples.length > 0) {
        console.log('\n  【skillYears 未取得サンプル（Drive/resumenリンクあり・スキル5件以上）】')
        samples.forEach(c => {
          const skillCount = Array.isArray(c.skills) ? c.skills.length : 0
          console.log(`    ID:${c.id.slice(0, 8)}  name:${c.name ?? '?'}  skills:${skillCount}件  drive:${c.drive_url ? 'あり' : '-'}  resume:${c.resume_url ? 'あり' : '-'}`)
        })
      }
    }
  }
} catch (e) {
  warn(`skillYears チェック失敗: ${e.message}`)
}

// ============================================================
// 12. 抽出ロジック回帰テスト
// ============================================================
H('⑫ 抽出ロジック回帰テスト')
try {
  const { execSync } = await import('child_process')
  const output = execSync('node scripts/test_extraction.mjs --test', {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
  })
  // 最後の「テスト結果: N passed, M failed」行を抽出
  const resultLine = output.split('\n').findLast(l => l.includes('テスト結果:') || l.includes('passed'))
  if (resultLine) {
    const failed = resultLine.match(/(\d+)\s*failed/)
    if (failed && parseInt(failed[1]) > 0) {
      warn(`回帰テスト失敗: ${resultLine.trim()}`)
    } else {
      ok(resultLine.trim())
    }
  } else {
    ok('テスト完了（詳細は node scripts/test_extraction.mjs --test で確認）')
  }
} catch (e) {
  warn(`回帰テスト失敗: ${e.message.slice(0, 120)}`)
}

// ============================================================
// 完了
// ============================================================
console.log(`\n${'─'.repeat(60)}`)
console.log(`  品質チェック完了`)
if (!INCLUDE_LOGS) info('Edge Functionログを含める場合: node scripts/quality_check.mjs --logs')
console.log('')
