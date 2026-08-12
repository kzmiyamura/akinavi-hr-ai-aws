#!/usr/bin/env node
/**
 * audit_replay_experience_impact.mjs
 *   一括再解析（bulk_replay_missing_skillyears.mjs）を再開したら
 *   経験年数がどう変わるかを、DBを一切変更せずに測る。
 *
 * 背景（2026-08-12）: 再解析すると experience_years が「年齢−22」の推定値から
 * 「経歴書から読んだ実期間」に置き換わり、下振れする人が出るため一括処理を止めていた。
 * 何人がどれだけ動くのか分からないまま止まっていたので、先に測れるようにする。
 *
 * やっていること: 対象者の経歴書Excelを本番と同じ抽出経路（worksheetToGrid /
 * worksheetToCells → Unified / Cells → 品質スコアで勝者決定）に通し、
 * inbound-email と同じ優先順位（日付スパン → 案件期間合計 → スキル最大月数）で
 * 経験年数を出して、今のDB値と比べる。サニティチェック（1年未満・年齢-15超は棄却して
 * 年齢−22にフォールバック）も本番に合わせている。
 *
 * 再現していないもの: 本文（メール本文・PDF）由来の regex 経験年数。本文に
 * 「経験年数：N年」と明記がある人は本番ではそちらが優先されることがある。
 * このツールは「Excelから読める値」と「今のDB値」の比較に徹する。
 *
 * 使い方:
 *   node scripts/audit_replay_experience_impact.mjs             # 直近7日・先頭30件
 *   node scripts/audit_replay_experience_impact.mjs 365 --limit 50
 *   node scripts/audit_replay_experience_impact.mjs --all       # 件数制限なし（Storage転送量に注意）
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'
import {
  extractSkillYearsUnified,
  extractSkillYearsFromCells,
  filterSkillYears,
  scoreSkillQuality,
  worksheetToGrid,
  worksheetToCells,
} from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }

const args = process.argv.slice(2)
const limitAt = args.indexOf('--limit')
const LIMIT = args.includes('--all') ? Infinity : (Number(limitAt >= 0 ? args[limitAt + 1] : 0) || 30)
const DAYS = Number(args.find((a, i) => /^\d+$/.test(a) && i !== limitAt + 1) ?? 7)
const since = new Date(Date.now() - DAYS * 86400000).toISOString()
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`, { headers })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const hasSy = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length > 0

// 一覧は軽い項目のみ（raw_profile を丸ごと取らない）
const rows = await fetchAll(
  'candidates?select=id,name,resume_url,experience_years,sy:raw_profile->skillYears,age:raw_profile->age' +
  `&data_env=eq.prod&merged_into=is.null&created_at=gte.${since}&resume_url=not.is.null`)

const targets = rows
  .filter((c) => !hasSy(c.sy) && String(c.resume_url).includes('supabase.co/storage'))
  .filter((c) => /\.xlsx?($|\?)/i.test(String(c.resume_url)))

console.log(`再解析対象（直近${DAYS}日・skillYears空・Excel経歴書）: ${targets.length}件`)
console.log(`うち ${Math.min(targets.length, LIMIT)} 件を検査します\n`)

/** 本番（inbound-email）と同じ経路で Excel から skillYears を作る */
function extractSkillYears(buf) {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
  let best = null, bestScore = -1
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    let syGrid = {}, syCells = {}
    try { syGrid = extractSkillYearsUnified(worksheetToGrid(ws)) } catch { /* 本番も try で握る */ }
    try { syCells = filterSkillYears(extractSkillYearsFromCells(worksheetToCells(ws))) } catch { /* 同上 */ }
    const cg = scoreSkillQuality(syGrid), cc = scoreSkillQuality(syCells)
    if (cg <= 0 && cc <= 0) continue
    const winner = { ...(cc >= cg ? syCells : syGrid) }
    if (syCells['_totalProjectMonths'] && !winner['_totalProjectMonths']) winner['_totalProjectMonths'] = syCells['_totalProjectMonths']
    if (syCells['_dateSpanMonths'] && !winner['_dateSpanMonths']) winner['_dateSpanMonths'] = syCells['_dateSpanMonths']
    const score = Math.max(cg, cc)
    if (score > bestScore) { bestScore = score; best = filterSkillYears(winner) }
  }
  return best
}

/** inbound-email と同じ優先順位で経験年数（年）を出す */
function estimateYears(sy, age) {
  if (!sy || Object.keys(sy).length === 0) return null
  const skillVals = Object.entries(sy)
    .filter(([k]) => k !== '_totalProjectMonths' && k !== '_dateSpanMonths')
    .map(([, v]) => v)
  const months = sy['_dateSpanMonths']
    ?? sy['_totalProjectMonths']
    ?? (skillVals.length > 0 ? Math.max(...skillVals) : null)
  if (!months || months <= 0) return null
  const years = months / 12
  // 本番のサニティチェック: 1年未満 / 年齢-15 超は棄却
  if (years < 1) return null
  if (age != null && years > age - 15) return null
  return years
}

const results = []
for (const c of targets.slice(0, LIMIT)) {
  try {
    const res = await fetch(c.resume_url)
    if (!res.ok) { results.push({ c, err: `取得${res.status}` }); continue }
    const buf = Buffer.from(await res.arrayBuffer())
    const sy = extractSkillYears(buf)
    const est = estimateYears(sy, c.age)
    // 抽出できなければ本番は年齢−22にフォールバックする
    const after = est != null ? Math.round(est)
      : (c.age != null && c.age >= 24 && c.age <= 70 ? c.age - 22 : null)
    results.push({ c, sy, est, after })
  } catch (e) {
    results.push({ c, err: String(e).slice(0, 60) })
  }
}

const ageGuess = (c) => (c.age != null && c.age >= 24 && c.age <= 70 ? c.age - 22 : null)
const cat = (r) => {
  if (r.err) return 'エラー'
  if (r.after == null) return '判定不能'
  if (r.c.experience_years == null) return '新規に付く'
  const d = r.after - r.c.experience_years
  if (d === 0) return '変化なし'
  return d > 0 ? '上振れ' : '下振れ'
}

const groups = {}
for (const r of results) (groups[cat(r)] ??= []).push(r)

console.log('=== 再解析したときの経験年数の変化 ===')
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${k.padEnd(8)} ${String(v.length).padStart(3)}件`)
}

const down = (groups['下振れ'] ?? []).sort(
  (a, b) => (a.after - a.c.experience_years) - (b.after - b.c.experience_years))
if (down.length > 0) {
  console.log('\n=== 下振れする人（大きい順） ===')
  console.log('  氏名          年齢  今  →  後   差   根拠                今の値は年齢推定か')
  for (const r of down.slice(0, 25)) {
    const src = r.sy?.['_dateSpanMonths'] != null ? `日付スパン${r.sy['_dateSpanMonths']}ヶ月`
      : r.sy?.['_totalProjectMonths'] != null ? `案件合計${r.sy['_totalProjectMonths']}ヶ月`
      : r.est != null ? 'スキル最大月数' : '抽出できず→年齢−22'
    // 本番は「Excel由来の値が今の値より大きいときだけ上書き」する（index.ts:10404）。
    // つまり本文由来の値は下がらない。今の値が年齢−22と一致する人＝本文由来が無い人だけが動く
    const isGuess = ageGuess(r.c) === r.c.experience_years
      ? '★年齢−22と一致' : '本文由来か。本番では下がらない見込み'
    console.log(`  ${String(r.c.name ?? '').padEnd(12)} ${String(r.c.age ?? '—').padStart(3)}  ${String(r.c.experience_years).padStart(2)} → ${String(r.after).padStart(2)}  ${String(r.after - r.c.experience_years).padStart(4)}   ${src.padEnd(20)} ${isGuess}`)
  }
  const guessCount = down.filter(r => ageGuess(r.c) === r.c.experience_years).length
  console.log(`\n  下振れ${down.length}件のうち ${guessCount}件 は今の値が「年齢−22」の当てずっぽうと一致する。`)
  console.log('  この分は「推定値が実測値に置き換わる」だけで、劣化ではない。')
  console.log('  残りは本文（メール本文・PDF）由来の値を持つ人。本番は Excel 由来の値が')
  console.log('  今の値より大きいときしか上書きしない（index.ts:10404）ので、実際には下がらない。')
}
