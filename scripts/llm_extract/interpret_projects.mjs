#!/usr/bin/env node
// 案件条件のAI解釈（複数名前提・関連スキル）を手動で回す。既定はドライラン（DBを変えない）。
//
// 使い方:
//   node scripts/llm_extract/interpret_projects.mjs              # 未解釈の open 案件をドライラン
//   node scripts/llm_extract/interpret_projects.mjs --limit 2    # 件数を絞る
//   node scripts/llm_extract/interpret_projects.mjs --run        # 実際に raw_data に書く
//   node scripts/llm_extract/interpret_projects.mjs --id <uuid> --force  # 解釈済みでも再実行
//
// ワーカー（shadow_worker.mjs の projectInterpretCycle）と同じ関数を使うので、
// ここで見た出力がそのまま本番の挙動になる。env は ~/.akinavi_shadow.env から読む。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractProjectInterpretation } from './run.mjs'
import { buildInterpretationPatch, normTech } from './project_apply.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY がありません'); process.exit(1) }

const args = process.argv.slice(2)
const RUN = args.includes('--run')
const FORCE = args.includes('--force')
const idOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const ID = idOf('--id')
const LIMIT = Number(idOf('--limit') ?? 10)

async function rest(pathq, opts = {}) {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const t = await res.text()
  return t.trim() ? JSON.parse(t) : null
}

const master = new Set()
for (let from = 0; ; from += 1000) {
  const rows = await rest(`skill_master?select=name,aliases&limit=1000&offset=${from}`)
  if (!rows?.length) break
  for (const r of rows) for (const n of [r.name, ...(r.aliases || [])]) { const k = normTech(n); if (k) master.add(k) }
  if (rows.length < 1000) break
}

const sel = 'id,title,required_skills,raw_data,status'
const q = ID
  ? `projects?select=${sel}&id=eq.${ID}`
  : `projects?select=${sel}&data_env=eq.prod&status=eq.open` +
    (FORCE ? '' : '&raw_data->>aiInterpretation=is.null') +
    `&order=created_at.desc&limit=${LIMIT}`
const rows = await rest(q)
if (!rows?.length) { console.log('対象の案件がありません（全件解釈済みか、open 案件なし）'); process.exit(0) }
console.log(`${rows.length}件を${RUN ? '解釈して書き込み' : 'ドライラン'}\n`)

for (const p of rows) {
  const text = String(p.raw_data?.text ?? '')
  console.log(`■ ${p.title} (${p.id.slice(0, 8)})`)
  if (text.length < 50) { console.log('  本文なし・スキップ\n'); continue }
  if ((p.raw_data?.batchSize ?? 1) > 1) { console.log('  複数案件メール由来・スキップ\n'); continue }
  const r = await extractProjectInterpretation(text.slice(0, 8000))
  const { patch, changes } = buildInterpretationPatch(p, r, master)
  const ai = patch.raw_data.aiInterpretation
  console.log(`  複数名前提: ${ai.multiPerson}${ai.evidence ? `（根拠:「${ai.evidence}」）` : ''}`)
  console.log(`  確信度: ${ai.confidence}`)
  const dropped = (r.relatedSkills ?? []).filter((s) => !ai.relatedSkills.some((a) => a.name === s?.name))
  for (const s of ai.relatedSkills) console.log(`  関連スキル採用: ${s.name} — ${s.reason ?? ''}`)
  for (const s of dropped) console.log(`  不採用(辞書外/重複): ${s?.name}`)
  console.log(`  変更: ${changes.length ? changes.join(', ') : 'なし（印のみ）'}`)
  if (RUN) {
    await rest(`projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
    console.log('  → 書き込み済み')
  }
  console.log('')
}
