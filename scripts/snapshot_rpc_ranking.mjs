/**
 * snapshot_rpc_ranking.mjs
 * open 案件ごとに fetch_candidates_for_project を呼び、返る候補者IDの並びを保存する。
 * RPC を書き換える前後で実行して差分を取るための回帰用（配点を変えていないことの確認）。
 *
 * Usage:
 *   node scripts/snapshot_rpc_ranking.mjs <出力パス> [--anon]
 *
 * 既定は service_role（anon は statement_timeout で落ちる案件があるため）。
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'fs'

const OUT = process.argv[2]
if (!OUT) { console.error('出力パスを渡す'); process.exit(1) }
const USE_ANON = process.argv.includes('--anon')

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}
let key = process.env.VITE_SUPABASE_ANON_KEY
if (!USE_ANON) {
  const wt = readFileSync(new URL('.akinavi_shadow.env', `file:///${process.env.USERPROFILE.replace(/\\/g, '/')}/`), 'utf8')
  for (const line of wt.split(/\r?\n/)) {
    const m = line.match(/^\s*export\s+([A-Z_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  key = process.env.SUPABASE_SERVICE_KEY
}
const supabase = createClient(process.env.VITE_SUPABASE_URL, key)

const W = { skill: 40, exp: 15, rate: 15, location: 20, remote: 10 }

const { data: projects, error } = await supabase
  .from('projects').select('*').eq('data_env', 'prod').eq('status', 'open')
  .order('created_at', { ascending: false })
if (error) { console.error(error.message); process.exit(1) }

const out = {}
for (const p of projects) {
  const t0 = Date.now()
  const { data, error: e } = await supabase.rpc('fetch_candidates_for_project', {
    p_data_env: 'prod',
    p_required_skills: Array.isArray(p.required_skills) ? p.required_skills : [],
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
  if (e) {
    out[p.id] = { error: e.message, ms }
    console.log(`${String(ms).padStart(6)}ms  NG  ${p.title.slice(0, 30)}`)
  } else {
    out[p.id] = { ids: data.map(r => r.id), ms }
    console.log(`${String(ms).padStart(6)}ms  ${String(data.length).padStart(4)}件  ${p.title.slice(0, 30)}`)
  }
}
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\n→ ${OUT}`)
