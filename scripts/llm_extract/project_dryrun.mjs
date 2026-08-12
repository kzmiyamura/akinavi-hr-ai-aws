#!/usr/bin/env node
// llm_extract/project_dryrun.mjs — 案件LLM補正のドライラン（DB書き込みなし）
//
// 直近の prod 案件（raw_data.text あり）に extractProjectFields を回し、
// buildProjectPatch が「適用するはずの変更」を表示する。ポリシー調整の判断材料用。
//
// 使い方:
//   node scripts/llm_extract/project_dryrun.mjs [件数=10]
//   --apply を付けると実際に PATCH する（既定はドライラン・書き込みなし）
//
// env は ~/.akinavi_shadow.env から自分で読む（source は allowlist に登録できず
// 実行のたびに承認待ちで止まるため。sb-query.mjs と同じ方針）
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractProjectFields } from './run.mjs'
import { buildProjectPatch } from './project_apply.mjs'
import { normTech } from './lib.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!m) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください'); process.exit(1) }
const APPLY = process.argv.includes('--apply')
const N = Number(process.argv.filter(a => /^\d+$/.test(a))[0] ?? 10)

async function rest(q, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`${q} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return text.trim() ? JSON.parse(text) : null
}

async function skillMasterSet() {
  const s = new Set()
  for (let from = 0; ; from += 1000) {
    const rows = await rest(`skill_master?select=name,aliases&limit=1000&offset=${from}`)
    if (!rows?.length) break
    for (const r of rows) for (const n of [r.name, ...(r.aliases || [])]) { const k = normTech(n); if (k) s.add(k) }
    if (rows.length < 1000) break
  }
  return s
}

const rows = await rest(
  `projects?select=id,title,client,description,required_skills,budget_min,budget_max,start_date,work_location,remote_policy,contract_type,headcount,workload,settlement_min,settlement_max,role_summary,industry,raw_data,created_at` +
  `&data_env=eq.prod&raw_data->>text=not.is.null&order=created_at.desc&limit=${N}`)
console.log(`対象 ${rows.length} 件（prod・raw_data.text あり・新しい順）モード=${APPLY ? '★適用' : 'ドライラン'}\n`)
const sm = await skillMasterSet()

let totalChanges = 0, multiSkip = 0
for (const p of rows) {
  const text = String(p.raw_data?.text ?? '')
  if (text.length < 50) { console.log(`--- ${p.title} : 本文が短いためスキップ`); continue }
  const r = await extractProjectFields(text.slice(0, 8000))
  if ((r.projects?.length ?? 0) !== 1) {
    multiSkip++
    console.log(`--- ${p.title} : LLMが${r.projects?.length ?? 0}案件を検出（1件でないため適用対象外）`)
    continue
  }
  const f = { ...r.projects[0], _model: r.model }
  const { patch, changes } = buildProjectPatch(p, f, sm)
  console.log(`--- ${p.title} (${p.id.slice(0, 8)}) confidence=${r.confidence}`)
  if (!patch) { console.log('    変更なし'); continue }
  totalChanges++
  for (const c of changes) {
    const key = c.replace(/\(.*/, '')
    const before = key in patch ? p[key] : p.raw_data?.[key]
    const after = key in patch ? patch[key] : patch.raw_data?.[key]
    console.log(`    ${c}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  }
  if (APPLY) {
    await rest(`projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
    console.log('    → 適用済み')
  }
}
console.log(`\n変更あり ${totalChanges}/${rows.length} 件・複数案件スキップ ${multiSkip} 件`)
