#!/usr/bin/env node
/**
 * monitor_quality.mjs — inbound-email 品質の週次監視（一発コマンド）
 *
 * 「添付があるのに◯◯が無い」系のサイレント劣化と、ゾーンTが記録した異常を突合せて一覧する。
 * 異常が出た候補者は `node scripts/trace_email.mjs <id>` で全行程を追える。
 *
 * 使い方:
 *   node scripts/monitor_quality.mjs                # 本番・直近7日
 *   node scripts/monitor_quality.mjs --days 14      # 本番・直近14日
 *   node scripts/monitor_quality.mjs --local        # ローカルSupabase（テスト環境）に対して実行
 *
 * チェック項目:
 *   [A] invariantViolations が空でない（設計上の不変条件違反 = どこかでサイレント失敗）
 *   [B] 添付/リンクがあるのに skillYears が空（抽出漏れ or 新フォーマット）
 *   [C] 添付/リンクがあるのに resume_url が null（経歴書ボタンが出ない）
 *   [D] トレースに異常コード（B-PARSE-ERR / A-FETCH-FAIL / E-STO-FAIL / C-ROW-LINK-FAIL / D-UNASSIGNED / B-EXTRACT-EMPTY）
 *   [E] 未対応形式の添付が無視された（unrecognizedAttachments）
 *   [F] 名前が「不明」のまま登録された
 *
 * egress配慮: raw_profile全体ではなくJSON部分選択で必要キーのみ取得（1件あたり数百バイト）
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
}
loadEnv()

const args = process.argv.slice(2)
const daysIdx = args.indexOf('--days')
const DAYS = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 7
const LOCAL = args.includes('--local')

// ローカルモード: `supabase status` の Secret を SERVICE_ROLE_KEY 環境変数で渡す
const URL = LOCAL ? (process.env.LOCAL_SUPABASE_URL ?? 'http://127.0.0.1:54331') : process.env.VITE_SUPABASE_URL
const KEY = LOCAL ? process.env.SERVICE_ROLE_KEY : process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error(LOCAL
    ? 'SERVICE_ROLE_KEY が未設定です（supabase status の Secret を環境変数で渡してください）'
    : '接続情報が未設定です（.env.local の VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
  process.exit(1)
}

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase REST ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

const since = new Date(Date.now() - DAYS * 86400_000).toISOString()
// JSON部分選択でegressを最小化（raw_profile全体は取らない）
const SELECT = [
  'id', 'name', 'created_at', 'resume_url', 'data_env',
  'skillYears:raw_profile->skillYears',
  'trace:raw_profile->pipeline_trace',
  'attachmentNames:raw_profile->attachmentNames',
  'sourceAttachmentCount:raw_profile->sourceAttachmentCount',
  'driveLinks:raw_profile->driveLinks',
  'excelParseNotes:raw_profile->excelParseNotes',
  'unrecognized:raw_profile->unrecognizedAttachments',
].join(',')

const rows = await rest(`candidates?select=${SELECT}&created_at=gte.${since}&order=created_at.desc&limit=1000`)

const BAD_CODES = ['B-PARSE-ERR', 'A-FETCH-FAIL', 'E-STO-FAIL', 'C-ROW-LINK-FAIL', 'D-UNASSIGNED', 'B-EXTRACT-EMPTY']
const findings = { A: [], B: [], C: [], D: [], E: [], F: [] }

for (const r of rows) {
  const hasSource = (r.sourceAttachmentCount ?? 0) > 0
    || (Array.isArray(r.attachmentNames) && r.attachmentNames.length > 0)
    || (Array.isArray(r.driveLinks) && r.driveLinks.length > 0)
  const skillYearsEmpty = !r.skillYears || Object.keys(r.skillYears).length === 0
  const violations = r.trace?.invariantViolations ?? []
  const traceStr = JSON.stringify(r.trace ?? {})
  const badCodes = BAD_CODES.filter(c => traceStr.includes(c))

  if (violations.length > 0) findings.A.push({ ...r, why: violations.join(', ') })
  if (hasSource && skillYearsEmpty) findings.B.push({ ...r, why: (r.excelParseNotes ?? []).join(' / ') || 'skillYears空（パースノートなし）' })
  if (hasSource && !r.resume_url) findings.C.push({ ...r, why: `添付/リンクあり resume_url=null` })
  if (badCodes.length > 0) findings.D.push({ ...r, why: badCodes.join(', ') })
  if (Array.isArray(r.unrecognized) && r.unrecognized.length > 0) findings.E.push({ ...r, why: r.unrecognized.join(' / ') })
  if (r.name === '不明') findings.F.push({ ...r, why: '名前不明' })
}

const LABELS = {
  A: '🚨 不変条件違反（サイレント失敗の疑い・最優先で調査）',
  B: '⚠️  添付/リンクありなのに skillYears 空（新フォーマットの可能性 → testData/excel/ に追加して改善ループ）',
  C: '⚠️  添付/リンクありなのに resume_url なし（経歴書ボタンが出ない）',
  D: '⚠️  トレースに異常コード（取得失敗/パース失敗/Storage失敗/未割当）',
  E: 'ℹ️  未対応形式の添付が無視された',
  F: 'ℹ️  名前不明のまま登録',
}

console.log(`\n═══ inbound-email 品質監視 ═══`)
console.log(`対象: ${LOCAL ? 'ローカル' : '本番'} / 直近${DAYS}日 / 候補者 ${rows.length}件\n`)

let total = 0
for (const key of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const list = findings[key]
  console.log(`${LABELS[key]}: ${list.length}件`)
  for (const f of list.slice(0, 10)) {
    console.log(`   - ${f.name} (${String(f.created_at).slice(0, 10)}) [${f.data_env}] id=${f.id}`)
    console.log(`     └ ${String(f.why).slice(0, 140)}`)
  }
  if (list.length > 10) console.log(`   …他${list.length - 10}件`)
  total += list.length
}

console.log(`\n📊 検出合計: ${total}件（重複計上あり）`)
if (total > 0) console.log(`🔍 詳細調査: node scripts/trace_email.mjs <id>${LOCAL ? '（ローカルは要 --local 相当のURL設定）' : ''}`)
else console.log('✅ 異常なし')
