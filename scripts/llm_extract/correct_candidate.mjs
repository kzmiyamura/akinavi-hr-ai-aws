#!/usr/bin/env node
// correct_candidate.mjs — 指定した1人だけを今すぐ Haiku で校正する（ワーカーの順番待ちを飛ばす）
//
// 常駐ワーカーはキュー方式＋ペース配分なので、「この人をいま直したい」ができなかった。
// shadow_worker.mjs の processCandidate と同じ部品（extractBodyFields / extractProjects /
// buildPatch / mergeSkills）を同じ順序で呼ぶ。**判定ロジックはこちらに持たせない**
// ——増やすとワーカーと食い違うため、抽出も反映もすべて共有関数に委ねる。
//
// 使い方:
//   node scripts/llm_extract/correct_candidate.mjs <candidate_id>          # ドライラン（既定）
//   node scripts/llm_extract/correct_candidate.mjs <candidate_id> --run    # 本番上書き
//
// ワーカーとの違い（意図的）:
//   - 日次上限・LOOKBACK・スキル絞込を見ない（手動指定なので対象判定は不要）
//   - llm_shadow への記録はしない（手動実行の1件を日次集計に混ぜない）
//   - 隔離判定（非人材・幽霊）はしない。誤隔離が手動操作で起きると復旧が面倒なため、
//     疑わしい場合はワーカー本体に任せる
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { buildGridInput, buildTextGridInput } from './lib.mjs'
import { extractProjects, extractBodyFields } from './run.mjs'
import { buildPatch, pickBodyFieldsFor, mergeSkills, techsFromProjects, SKILLS_REPLACE } from './apply.mjs'
import { trimBodyForLlm } from './shadow_worker_lib.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/(?:export\s+)?(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv.find((a) => !a.startsWith('--') && /^[0-9a-f-]{36}$/i.test(a))
const RUN = process.argv.includes('--run')
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }
if (!id) { console.error('使い方: node scripts/llm_extract/correct_candidate.mjs <candidate_id> [--run]'); process.exit(1) }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const rest = async (q, opt = {}) => {
  const res = await fetch(`${URL}/rest/v1/${q}`, { ...opt, headers: { ...H, ...(opt.headers || {}) } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// buildPatch / mergeSkills が参照するトップレベル列は必ず select に含めること
// （欠けると「既存値なし」と誤認して fill 項目まで上書きする。2026-08-08 に実害）
const [c] = await rest(`candidates?id=eq.${id}&select=id,name,resume_url,raw_profile,created_at,` +
  `desired_rate,from_company,experience_years,skills`)
if (!c) { console.error('候補者が見つかりません:', id); process.exit(1) }
console.log(`対象: ${c.name} (${c.id})  登録=${c.created_at}  ${RUN ? '★本番上書き' : 'ドライラン'}`)

let bodyFields = null, attachment = null

// ── 本文（Haiku）──
const bodyText = c.raw_profile?.text ?? ''
if (bodyText.length > 50) {
  const bf = await extractBodyFields(trimBodyForLlm(bodyText))
  bodyFields = pickBodyFieldsFor(c.name, bf.candidates)
  if (bodyFields) bodyFields._model = bf.model
  else console.log('  本文に複数人・特定不可のため本文フィールドは上書きせず')
  console.log(`  本文: model=${bf.model} 抽出${bf.candidates?.length ?? 0}人`)
}

// ── 経歴書（Haiku）──
const extMatch = c.resume_url ? c.resume_url.toLowerCase().match(/\.(xlsx?|xlsm|docx|pdf)$/) : null
if (extMatch) {
  const ext = extMatch[1]
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akinavi-correct-'))
  const fp = path.join(tmp, `${c.id}.${ext}`)
  try {
    const res = await fetch(c.resume_url)
    if (!res.ok) throw new Error(`resume DL ${res.status}`)
    fs.writeFileSync(fp, Buffer.from(await res.arrayBuffer()))
    let grid, kind = 'grid'
    if (ext === 'docx' || ext === 'pdf') {
      const { extractResumeText } = await import('./textract.mjs')
      grid = buildTextGridInput(await extractResumeText(fp, ext), ext)
      kind = 'text'
    } else {
      grid = buildGridInput(fp)
    }
    if (!grid) throw new Error(`no date cells in ${ext}`)
    const r = await extractProjects(grid, { log: (m) => console.log('  経歴書:', m), kind })
    attachment = { projects: r.projects, skill_years: r.skillYears, model: r.model, status: r.status }
    console.log(`  経歴書: model=${r.model} status=${r.status} projects=${r.projects?.length ?? 0}`)
  } catch (e) {
    console.log('  経歴書の解析に失敗:', String(e).slice(0, 200))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (!bodyFields && !attachment) { console.log('解析対象なし（本文が短く添付も無い）'); process.exit(0) }

const { patch, changes } = buildPatch(c, { bodyFields, attachment })
if (!patch) {
  console.log('変更なし（AIの出力は既存値と同じ）')
  if (RUN) {
    const rp = { ...(c.raw_profile || {}), _llm_checked_at: new Date().toISOString(), _llm_stage: 'done' }
    await rest(`candidates?id=eq.${c.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
    })
    console.log('校正済みの印のみ記録しました')
  }
  process.exit(0)
}
patch.raw_profile._llm_checked_at = new Date().toISOString()
patch.raw_profile._llm_stage = 'done'

// skills はワーカーと同じく「skill_master にある未登録スキルの追加のみ」。
// skill_master はページングして全件取る（PostgREST は1000行で黙って切る）
if (attachment?.projects?.length) {
  const techs = techsFromProjects(attachment.projects)
  if (SKILLS_REPLACE) {
    patch.skills = techs
    changes.push('skills(全置換)')
  } else {
    const master = new Set()
    for (let from = 0; ; from += 1000) {
      const rows = await rest(`skill_master?select=name,aliases&limit=1000&offset=${from}`)
      for (const r of rows) {
        master.add(String(r.name).toLowerCase().replace(/[\s　]/g, ''))
        for (const a of r.aliases ?? []) master.add(String(a).toLowerCase().replace(/[\s　]/g, ''))
      }
      if (rows.length < 1000) break
    }
    const merged = mergeSkills(c.skills, techs, master)
    if (merged) { patch.skills = merged; changes.push(`skills(+${merged.length - (c.skills?.length ?? 0)})`) }
  }
}

console.log(`\n変更: ${changes.join(', ')}`)
for (const [k, v] of Object.entries(patch)) {
  if (k === 'raw_profile') continue
  console.log(`  ${k}: ${JSON.stringify(c[k])} → ${JSON.stringify(v)}`)
}
const sy = patch.raw_profile?.skillYears
if (sy) console.log(`  skillYears: ${Object.keys(c.raw_profile?.skillYears ?? {}).length}件 → ${Object.keys(sy).length}件`)

if (!RUN) { console.log('\n（ドライラン。上書きするには --run）'); process.exit(0) }
await rest(`candidates?id=eq.${c.id}`, {
  method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
})
console.log('\n上書きしました')
