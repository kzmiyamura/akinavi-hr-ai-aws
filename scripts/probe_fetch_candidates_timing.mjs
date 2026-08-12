/**
 * probe_fetch_candidates_timing.mjs
 * fetch_candidates_for_project を必須スキルの組み合わせを変えて呼び、
 * どのスキルが実行時間を押し上げてタイムアウトさせているかを切り分ける。
 * 読み取り専用（DB は変更しない）。
 *
 * Usage:
 *   node scripts/probe_fetch_candidates_timing.mjs <project_id先頭一致>
 *   node scripts/probe_fetch_candidates_timing.mjs 82da71a0 --skills "SQL,Java"
 *
 * 引数なしの --skills 省略時は、必須スキルを1つずつ単独で試し、
 * 次に1つずつ抜いて試す（どれが重いかが分かる）。
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

// --service を付けると service_role で呼ぶ（anon のロール別 statement_timeout の切り分け用）
const USE_SERVICE = process.argv.includes('--service')
let url = process.env.VITE_SUPABASE_URL
let key = process.env.VITE_SUPABASE_ANON_KEY
if (USE_SERVICE) {
  const wt = readFileSync(new URL('.akinavi_shadow.env', `file:///${process.env.USERPROFILE.replace(/\\/g, '/')}/`), 'utf8')
  for (const line of wt.split(/\r?\n/)) {
    const m = line.match(/^\s*export\s+([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  url = process.env.SUPABASE_URL
  key = process.env.SUPABASE_SERVICE_KEY
}
console.log(`role: ${USE_SERVICE ? 'service_role' : 'anon'}`)
const supabase = createClient(url, key)

const PREFIX = process.argv[2]
if (!PREFIX) { console.error('project_id の先頭一致を渡す'); process.exit(1) }
const skillsArgIdx = process.argv.indexOf('--skills')
const SKILLS_OVERRIDE = skillsArgIdx >= 0 ? process.argv[skillsArgIdx + 1].split(',').map(s => s.trim()) : null

const W = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }

const { data: projects, error } = await supabase
  .from('projects').select('*').eq('data_env', 'prod').eq('status', 'open')
if (error) { console.error(error.message); process.exit(1) }
const p = projects.find(x => x.id.startsWith(PREFIX))
if (!p) { console.error('該当案件なし'); process.exit(1) }

console.log(`案件: ${p.title}`)
console.log(`必須スキル: ${JSON.stringify(p.required_skills)}\n`)

async function run(label, skills) {
  const t0 = Date.now()
  const { data, error } = await supabase.rpc('fetch_candidates_for_project', {
    p_data_env: 'prod',
    p_required_skills: skills,
    p_budget_min: p.budget_min ?? null,
    p_budget_max: p.budget_max ?? null,
    p_work_location: p.work_location ?? null,
    p_remote_policy: p.remote_policy ?? null,
    p_limit: 500,
    p_weight_skill: W.skill, p_weight_exp: W.exp, p_weight_rate: W.rate,
    p_weight_location: W.location, p_weight_remote: W.remote,
    p_require_haken: false,
    p_work_prefecture: p.work_prefecture ?? null,
    p_required_exp_years: p.required_experience_years ?? null,
    p_skill_weights: p.skill_weights ?? null,
  })
  const ms = Date.now() - t0
  const status = error ? `NG (${error.message.slice(0, 40)})` : `OK ${data.length}件`
  console.log(`${String(ms).padStart(6)}ms  ${status.padEnd(30)} ${label}`)
  return !error
}

const req = Array.isArray(p.required_skills) ? p.required_skills : []

if (SKILLS_OVERRIDE) {
  await run(JSON.stringify(SKILLS_OVERRIDE), SKILLS_OVERRIDE)
} else {
  console.log('── 全部 ──')
  await run('（元のまま）', req)
  console.log('\n── 1つだけ ──')
  for (const s of req) await run(s, [s])
  console.log('\n── 1つ抜く ──')
  for (const s of req) await run(`除: ${s}`, req.filter(x => x !== s))
}
