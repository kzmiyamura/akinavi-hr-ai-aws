#!/usr/bin/env node
// llm_extract/apply_report.mjs — 本番上書きの答え合わせレポート
//
// shadow_report.mjs は llm_shadow と candidates を比較する作りだが、本番上書き後は
// candidates 側が AI 値になるため比較にならない。本スクリプトは上書き時に退避した
// raw_profile._regex_backup（旧regex値）と現在値を突き合わせて「AIが何をどう変えたか」を出す。
//
// 使い方: source ~/.akinavi_shadow.env && node scripts/llm_extract/apply_report.mjs [日数=7]
//         node scripts/llm_extract/apply_report.mjs --id <candidate_id>
//         node scripts/llm_extract/apply_report.mjs --json   (機械読み取り用)
import { normTech } from './lib.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください'); process.exit(1) }

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const idIdx = args.indexOf('--id')
const targetId = idIdx >= 0 ? args[idIdx + 1] : null
const days = Number(args.find(a => /^\d+$/.test(a)) ?? 7)

async function rest(q) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

// buildPatch (apply.mjs) と対応: top はカラム直、それ以外は raw_profile 内
const TOP_FIELDS = new Set(['name', 'desired_rate', 'from_company', 'experience_years', 'skills'])

const SELECT = 'id,name,from_company,desired_rate,experience_years,skills,created_at,raw_profile,resume_url'
const filter = targetId
  ? `candidates?select=${SELECT}&id=eq.${targetId}`
  : `candidates?select=${SELECT}&data_env=eq.prod` +
    `&raw_profile->_llm_applied->>at=gte.${encodeURIComponent(new Date(Date.now() - days * 86400e3).toISOString())}` +
    `&order=created_at.desc`
const cands = await rest(filter)

const fmt = v => {
  if (v == null || v === '') return '(空)'
  if (typeof v === 'string') return JSON.stringify(v)
  return JSON.stringify(v)
}

/** skillYears の旧⇔新の差分（メタキー _* は除外） */
function diffSkillYears(oldSY, newSY) {
  const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !k.startsWith('_')))
  const o = clean(oldSY), n = clean(newSY)
  const omap = new Map(Object.entries(o).map(([k, v]) => [normTech(k), { k, v }]))
  const nmap = new Map(Object.entries(n).map(([k, v]) => [normTech(k), { k, v }]))
  const removed = [...omap.entries()].filter(([nk]) => !nmap.has(nk)).map(([, x]) => x.k)
  const added = [...nmap.entries()].filter(([nk]) => !omap.has(nk)).map(([, x]) => x.k)
  const changed = [...omap.entries()]
    .filter(([nk, x]) => nmap.has(nk) && nmap.get(nk).v !== x.v)
    .map(([nk, x]) => `${x.k}:${x.v}→${nmap.get(nk).v}`)
  return { oldCount: Object.keys(o).length, newCount: Object.keys(n).length, removed, added, changed }
}

function summarizeProjects(projects) {
  const list = Array.isArray(projects) ? projects : []
  if (!list.length) return '0件'
  const starts = list.map(p => p.start).filter(Boolean)
  const ends = list.map(p => p.end).filter(Boolean)
  const techs = new Set(list.flatMap(p => p.techs || []))
  const range = starts.length ? ` ${starts.sort()[0]}〜${ends.sort().at(-1) ?? '?'}` : ''
  return `${list.length}件${range} 技術${techs.size}語`
}

const cap = (arr, n = 8) => arr.length > n ? [...arr.slice(0, n), `…他${arr.length - n}`] : arr

const report = []
for (const c of cands) {
  const rp = c.raw_profile || {}
  const applied = rp._llm_applied
  if (!applied) continue
  const backup = rp._regex_backup || {}
  const rows = []
  for (const field of applied.fields || []) {
    if (field.startsWith('skills')) {
      rows.push({ field: 'skills', note: field, now: `${(c.skills || []).length}語` })
      continue
    }
    const oldVal = backup[field]
    const newVal = TOP_FIELDS.has(field) ? c[field] : rp[field]
    if (field === 'skillYears') {
      const d = diffSkillYears(oldVal, newVal)
      rows.push({
        field,
        old: `${d.oldCount}語`, new: `${d.newCount}語`,
        removed: cap(d.removed), added: cap(d.added), changed: cap(d.changed),
      })
    } else if (field === 'projects') {
      rows.push({ field, old: summarizeProjects(oldVal), new: summarizeProjects(newVal) })
    } else {
      rows.push({ field, old: fmt(oldVal), new: fmt(newVal) })
    }
  }
  report.push({
    id: c.id, name: c.name, created_at: c.created_at,
    applied_at: applied.at, model: applied.model, status: applied.status,
    resume: c.resume_url ? 'あり' : 'なし',
    rows,
  })
}

if (asJson) {
  console.log(JSON.stringify({ count: report.length, report }, null, 1))
} else if (!report.length) {
  console.log(`上書き済みレコードなし（直近${targetId ? '指定ID' : days + '日'}）`)
} else {
  console.log(`上書き済み ${report.length}件\n`)
}
if (!asJson) for (const r of report) {
  console.log(`=== ${r.name}  (applied ${r.applied_at}  model=${r.model ?? '-'}  経歴書=${r.resume})`)
  console.log(`    id=${r.id}`)
  for (const row of r.rows) {
    if (row.field === 'skillYears') {
      console.log(`  ${row.field.padEnd(17)} ${row.old} → ${row.new}`)
      if (row.removed.length) console.log(`      消えた: ${row.removed.join(', ')}`)
      if (row.added.length) console.log(`      追加  : ${row.added.join(', ')}`)
      if (row.changed.length) console.log(`      年数差: ${row.changed.join(', ')}`)
    } else if (row.note) {
      console.log(`  ${row.field.padEnd(17)} ${row.note} → 現在${row.now}`)
    } else {
      console.log(`  ${row.field.padEnd(17)} ${row.old} → ${row.new}`)
    }
  }
  console.log()
}
