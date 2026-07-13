#!/usr/bin/env node
/**
 * audit_misregistration.mjs — 案件メールが candidate として誤登録されていないかの監査
 *
 * 背景: poll-email は「SKIPにも案件パターンにも一致しないメール」を全て candidate 扱いにする
 * （AI分類無効時のデフォルト）。案件パターンの網から漏れた案件メールは candidate として
 * 登録される。prod candidates +3,002 vs projects +3（2026-06/17以降）の乖離調査用。
 *
 * データソース: ai_logs（type='candidate'・raw_body 3,000字・30日保持）
 *   → candidates は7日でアーカイブされるが ai_logs なら30日分を遡れる
 *
 * 判定パターンは poll-email/index.ts と inbound-email/index.ts から実行時に動的抽出する
 * （コピーの陳腐化防止。パターンを本体に追加すれば監査も自動で追随する）。
 *
 * 使い方:
 *   node scripts/audit_misregistration.mjs                # 本番・直近30日
 *   node scripts/audit_misregistration.mjs --days 14      # 期間指定
 *   node scripts/audit_misregistration.mjs --local        # ローカルSupabase（動作確認用）
 *   node scripts/audit_misregistration.mjs --dump out.json # 疑い一覧をJSONに保存
 *
 * 出力の見方:
 *   [A] 現行ルールで project 判定 — 今のパターンなら弾けた（登録当時はパターンが無かった or 経路バグ）
 *   [B] 現行ルールで skip 判定   — 今のパターンならスキップできた
 *   [C] ヒューリスティック疑い    — 現行パターンの網にも掛からない案件メールの疑い（★パターン追加候補）
 */

import { readFileSync, existsSync, writeFileSync } from 'fs'
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
const DAYS = daysIdx !== -1 ? Number(args[daysIdx + 1]) : 30
const LOCAL = args.includes('--local')
const dumpIdx = args.indexOf('--dump')
const DUMP = dumpIdx !== -1 ? args[dumpIdx + 1] : null

const URL = LOCAL ? (process.env.LOCAL_SUPABASE_URL ?? 'http://127.0.0.1:54331') : process.env.VITE_SUPABASE_URL
const KEY = LOCAL ? process.env.SERVICE_ROLE_KEY : process.env.VITE_SUPABASE_ANON_KEY
if (!URL || !KEY) {
  console.error(LOCAL
    ? 'SERVICE_ROLE_KEY が未設定です（supabase status の Secret を環境変数で渡してください）'
    : '接続情報が未設定です（.env.local の VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
  process.exit(1)
}

// ── 判定パターンをソースから動的抽出 ────────────────────────────────────────

/** ソースコードから `const NAME = [ ... ]` の配列リテラルを抽出して eval する（regex/文字列リテラルのみの配列前提） */
function extractArray(src, name) {
  const lines = src.split('\n')
  const startIdx = lines.findIndex(l => new RegExp(`^\\s*const ${name}(?::[^=]+)? = \\[`).test(l))
  if (startIdx === -1) throw new Error(`パターン配列が見つからない: ${name}`)
  const indent = lines[startIdx].match(/^\s*/)[0]
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === `${indent}]`) {
      const body = lines.slice(startIdx, i + 1).join('\n').replace(new RegExp(`^\\s*const ${name}(?::[^=]+)? = `), '')
      return eval(body) // 自リポジトリのソース限定・regex/文字列リテラルのみ
    }
  }
  throw new Error(`配列の終端が見つからない: ${name}`)
}

const pollSrc = readFileSync(resolve(ROOT, 'supabase/functions/poll-email/index.ts'), 'utf-8')
const inboundSrc = readFileSync(resolve(ROOT, 'supabase/functions/inbound-email/index.ts'), 'utf-8')

const SKIP_SUBJECT_PATTERNS = extractArray(pollSrc, 'SKIP_SUBJECT_PATTERNS')
const SKIP_BODY_PATTERNS = extractArray(pollSrc, 'SKIP_BODY_PATTERNS')
const PROJECT_SUBJECT_PATTERNS = extractArray(pollSrc, 'PROJECT_SUBJECT_PATTERNS')
const PROJECT_BODY_PATTERNS = extractArray(pollSrc, 'PROJECT_BODY_PATTERNS')
const PROJECT_SOLICITATION_KEYWORDS = extractArray(inboundSrc, 'PROJECT_SOLICITATION_KEYWORDS')
const TRAINING_KEYWORDS = extractArray(inboundSrc, 'TRAINING_KEYWORDS')
const SUBJECT_SKIP_KEYWORDS = extractArray(inboundSrc, 'SUBJECT_SKIP_KEYWORDS')
// poll-email 276行目の件名インライン案件パターン（配列でないため手動ミラー・要同期）
const SUBJECT_PROJECT_INLINE_RE = /エンド直|直案件|直\s*案件|合う人材|ご紹介をお待ち|エンドユーザー.*直/

console.log(`パターン抽出: SKIP件名=${SKIP_SUBJECT_PATTERNS.length} SKIP本文=${SKIP_BODY_PATTERNS.length} 案件件名=${PROJECT_SUBJECT_PATTERNS.length} 案件本文=${PROJECT_BODY_PATTERNS.length} inbound勧誘=${PROJECT_SOLICITATION_KEYWORDS.length}`)

/** poll-email の isProjectByRuleBase 相当 */
function judgeProject(subject, body500) {
  if (SUBJECT_PROJECT_INLINE_RE.test(subject)) return true
  if (PROJECT_SUBJECT_PATTERNS.some(p => p.test(subject))) return true
  if (PROJECT_BODY_PATTERNS.some(p => p.test(body500))) return true
  return false
}

/** 現行パターンに掛からない案件メールを探すヒューリスティック（パターン追加候補の発見用） */
const PROJECT_HINT_SIGNALS = [
  [/精算|清算/, '精算'],
  [/商流/, '商流'],
  [/スキル要件|必須要件|必須[：:]/, '要件記述'],
  [/尚可|歓迎スキル/, '尚可/歓迎'],
  [/支払サイト/, '支払サイト'],
  [/エンド|元請|プライム/, 'エンド/元請'],
  [/外国籍不可|日本人のみ|国籍.*不問/, '国籍条件'],
  [/面談\s*[：:]?\s*\d+\s*回/, '面談回数'],
  [/貴社.*(所属|社員|要員)|御社.*(所属|社員|要員)/, '貴社要員'],
  [/リモート併用|フル出社|出社.*週\d/, '勤務形態指定'],
  [/長期|即日〜|随時|至急/, '時期表現'],
  [/\d{2,3}\s*[〜～-]\s*\d{2,3}\s*万/, '単価レンジ万'],
]
/** 人材メールらしさ（これがあれば案件疑いを打ち消す） */
const CANDIDATE_SIGNALS = [
  /【氏名】|【氏\s*名】|氏名[：:]/,
  /経歴書.*添付|スキルシート.*添付|添付.*経歴書|添付.*スキルシート/,
  /【年齢】|年齢[：:]\s*\d/,
  /【最寄駅?】|最寄駅?[：:]/,
  /弊社(所属|社員|個人事業主|パートナー)/,
]

function heuristicSuspect(subject, body) {
  const hits = PROJECT_HINT_SIGNALS.filter(([re]) => re.test(body)).map(([, label]) => label)
  const candidateHits = CANDIDATE_SIGNALS.filter(re => re.test(body)).length
  // 案件シグナル3個以上 かつ 人材シグナル1個以下 → 疑い
  return { suspected: hits.length >= 3 && candidateHits <= 1, hits, candidateHits }
}

// ── ai_logs 取得（ページング・JSON部分選択でegress配慮） ───────────────────

async function rest(path) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase REST ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

const since = new Date(Date.now() - DAYS * 86400_000).toISOString()
const SELECT = 'id,created_at,subject,raw_body,linked_id,from_address,name:ai_result->>name'
const PAGE = 500
let rows = []
for (let offset = 0; ; offset += PAGE) {
  const page = await rest(
    `ai_logs?select=${SELECT}&type=eq.candidate&model=eq.no-ai&created_at=gte.${since}` +
    `&order=created_at.desc&limit=${PAGE}&offset=${offset}`)
  rows = rows.concat(page)
  if (page.length < PAGE || rows.length >= 5000) break
}
console.log(`\n対象: ${LOCAL ? 'ローカル' : '本番'} / 直近${DAYS}日 / candidate登録ログ ${rows.length}件\n`)

// ── 監査実行 ────────────────────────────────────────────────────────────────

const buckets = { A: [], B: [], C: [] }
const signalFreq = new Map()

for (const r of rows) {
  const subject = r.subject ?? ''
  const body = (r.raw_body ?? '').replace(/\s+/g, ' ')
  const body500 = body.slice(0, 500)

  if (judgeProject(subject, body500)) {
    buckets.A.push({ ...r, why: '現行ルールでproject判定' })
    continue
  }
  if (SKIP_SUBJECT_PATTERNS.some(p => p.test(subject)) || SKIP_BODY_PATTERNS.some(p => p.test(body.slice(0, 1000)))) {
    buckets.B.push({ ...r, why: '現行ルールでskip判定（poll-email）' })
    continue
  }
  if (TRAINING_KEYWORDS.some(kw => body.includes(kw)) || SUBJECT_SKIP_KEYWORDS.some(kw => subject.includes(kw))) {
    buckets.B.push({ ...r, why: '現行ルールでskip判定（inbound-email: 研修/業務連絡）' })
    continue
  }
  if (PROJECT_SOLICITATION_KEYWORDS.some(kw => body.includes(kw))) {
    buckets.A.push({ ...r, why: 'inbound側の案件勧誘キーワードに一致' })
    continue
  }
  const h = heuristicSuspect(subject, body)
  if (h.suspected) {
    buckets.C.push({ ...r, why: `案件シグナル[${h.hits.join(',')}] 人材シグナル${h.candidateHits}個` })
    for (const hit of h.hits) signalFreq.set(hit, (signalFreq.get(hit) ?? 0) + 1)
  }
}

const show = (list, label) => {
  console.log(`${label}: ${list.length}件`)
  for (const f of list.slice(0, 12)) {
    console.log(`   - [${String(f.created_at).slice(0, 10)}] "${(f.subject ?? '').slice(0, 60)}" name=${f.name ?? '?'}`)
    console.log(`     └ ${f.why}  linked_id=${f.linked_id ?? 'null'}`)
  }
  if (list.length > 12) console.log(`   …他${list.length - 12}件`)
  console.log('')
}

show(buckets.A, '🔴 [A] 案件メールの誤登録（現行パターンなら弾けたもの）')
show(buckets.B, '🟠 [B] スキップ対象の誤登録（現行パターンならスキップ）')
show(buckets.C, '🟡 [C] ヒューリスティック疑い（現行パターンの網にも掛からない ★パターン追加候補）')

if (signalFreq.size > 0) {
  console.log('📊 [C]群の案件シグナル頻度（パターン追加の優先順位付けに使う）:')
  for (const [sig, n] of [...signalFreq.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}件  ${sig}`)
  }
  console.log('')
}

const total = buckets.A.length + buckets.B.length + buckets.C.length
console.log(`📊 誤登録疑い合計: ${total} / ${rows.length}件（${rows.length > 0 ? (total / rows.length * 100).toFixed(1) : 0}%）`)
console.log(`   → 個別確認: node scripts/trace_email.mjs <linked_id>`)
console.log(`   → 対策: [A]は当時パターン不足（現行で解消済みの可能性）。[C]のシグナル頻度を見て`)
console.log(`     poll-email の PROJECT_BODY_PATTERNS にパターンを追加する`)

if (DUMP) {
  writeFileSync(DUMP, JSON.stringify({ generatedAt: new Date().toISOString(), days: DAYS, total: rows.length, buckets }, null, 1))
  console.log(`\n📝 ${DUMP} に保存しました`)
}
