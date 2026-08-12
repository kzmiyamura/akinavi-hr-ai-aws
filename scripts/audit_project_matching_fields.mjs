#!/usr/bin/env node
/**
 * audit_project_matching_fields.mjs — 案件側の抽出をマッチング精度の観点で測る
 *
 * fetch_candidates_for_project RPC がルールスコアに使う案件側の入力は5つだけ:
 *   required_skills(重み40) / budget_max(15) / work_location(20) / remote_policy(10) / require_haken
 * 経験年数(15)は候補者の experience_years だけを見ており、案件側の要求年数は存在しない。
 *
 * このスクリプトは
 *   ① スコアに効く項目がどれだけ埋まっているか（＝スコアが機能しているか）
 *   ② 抽出済みだがスコアに使われていない項目（raw_data / 未使用カラム）
 * を並べ、案件側抽出の再設計の材料にする。
 *
 * 使い方:
 *   node scripts/audit_project_matching_fields.mjs        # 直近30日・status=open
 *   node scripts/audit_project_matching_fields.mjs 90     # 直近90日
 *   node scripts/audit_project_matching_fields.mjs 90 --all   # status を問わない
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }

const args = process.argv.slice(2)
const DAYS = Number(args.find((a) => /^\d+$/.test(a)) ?? 30)
const ALL_STATUS = args.includes('--all')
const since = new Date(Date.now() - DAYS * 86400000).toISOString()
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// raw_data は本文を含み1件あたり大きいので、必要な子キーだけ JSON パスで取る（egress対策）
const select = [
  'id', 'title', 'status',
  'required_skills', 'budget_min', 'budget_max', 'work_location', 'remote_policy',
  'contract_type', 'headcount', 'workload', 'role_summary', 'industry',
  'settlement_min', 'settlement_max', 'start_date',
  'rsy:raw_data->requiredSkillYears',
  'nth:raw_data->niceToHaveSkills',
  'reng:raw_data->>requiresEnglish',
  'aet:raw_data->allowedEmploymentTypes',
].join(',')

const rows = []
for (let from = 0; ; from += 1000) {
  const q = `${URL}/rest/v1/projects?select=${select}&data_env=eq.prod&created_at=gte.${since}` +
    (ALL_STATUS ? '' : '&status=eq.open') + `&limit=1000&offset=${from}`
  const res = await fetch(q, { headers })
  if (!res.ok) { console.error(`${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1) }
  const page = await res.json()
  rows.push(...page)
  if (page.length < 1000) break
}

const N = rows.length
if (N === 0) { console.log(`対象0件（直近${DAYS}日${ALL_STATUS ? '' : '・status=open'}）`); process.exit(0) }
console.log(`案件 ${N}件（直近${DAYS}日${ALL_STATUS ? '・全ステータス' : '・status=open'}）\n`)

const filled = (v) => {
  if (v == null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return String(v).trim() !== ''
}
const pct = (n) => `${((n / N) * 100).toFixed(1)}%`.padStart(6)
const line = (label, n, note = '') =>
  console.log(`  ${label.padEnd(28)} ${String(n).padStart(4)}件 ${pct(n)}  ${note}`)

console.log('── ① ルールスコアに効く項目（埋まっていないと配点が死ぬ）──')
const skillN = rows.filter((r) => filled(r.required_skills)).length
line('required_skills  (重み40)', skillN, skillN < N ? `未設定は全候補者が一律0.5点扱い` : '')
const rateN = rows.filter((r) => filled(r.budget_max)).length
line('budget_max       (重み15)', rateN, rateN < N ? '未設定は単価差を無視（全員満点）' : '')
const locN = rows.filter((r) => filled(r.work_location)).length
line('work_location    (重み20)', locN, locN < N ? '未設定は全員0.25点で横並び' : '')
const remN = rows.filter((r) => filled(r.remote_policy)).length
line('remote_policy    (重み10)', remN, remN < N ? '未設定はリモート判定不能' : '')

const scored = rows.filter((r) => filled(r.required_skills) && filled(r.work_location))
console.log(`\n  skill+location が両方ある案件: ${scored.length}件 ${pct(scored.length)}`)
console.log(`  → 残り ${N - scored.length}件 は重み60/100が実質機能しない`)

console.log('\n── ② 抽出済みだがスコアに使われていない項目 ──')
for (const [label, key] of [
  ['contract_type（派遣/準委任）', 'contract_type'],
  ['role_summary（募集役割）', 'role_summary'],
  ['industry（業界）', 'industry'],
  ['workload（稼働）', 'workload'],
  ['headcount（人数）', 'headcount'],
  ['start_date（開始時期）', 'start_date'],
]) line(label, rows.filter((r) => filled(r[key])).length)

console.log('\n── ③ raw_data にあるがカラム化もスコア化もされていない項目 ──')
for (const [label, key] of [
  ['requiredSkillYears（要求年数）', 'rsy'],
  ['niceToHaveSkills（尚可スキル）', 'nth'],
  ['requiresEnglish（英語要否）', 'reng'],
  ['allowedEmploymentTypes（雇用形態）', 'aet'],
]) {
  const n = rows.filter((r) => filled(r[key]) && r[key] !== 'none').length
  line(label, n)
}

console.log('\n── ④ 人材側との対応が無い項目（案件側に受け皿が無い）──')
console.log('  必要経験年数        : 案件側カラム無し。経験年数の重み15は候補者の値だけで採点')
console.log('  必須スキルの年数要求  : raw_data.requiredSkillYears にあるが未使用')
console.log('  年齢上限            : 案件メールに頻出だが抽出項目なし')

const noSkill = rows.filter((r) => !filled(r.required_skills)).slice(0, 8)
if (noSkill.length > 0) {
  console.log('\n── required_skills が空の案件（先頭8件）──')
  for (const r of noSkill) console.log(`  ${String(r.title ?? '').slice(0, 54)}`)
}
