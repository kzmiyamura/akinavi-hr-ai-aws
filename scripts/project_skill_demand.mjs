#!/usr/bin/env node
// project_skill_demand.mjs — 案件が実際に求めているスキルを洗い出す
//
// AI校正の対象（app_config.llm_filter_skills）を決めるための材料。
// 「案件で求められている」かつ「人材側でも一定数ヒットする」スキルでないと
// 絞り込みとして機能しない（0人なら意味がなく、全員ヒットなら絞れていない）。
//
// 人材側の件数は count のみ取得する（egress を増やさないため）。
//
// 使い方:
//   node scripts/project_skill_demand.mjs            # status=open の案件
//   node scripts/project_skill_demand.mjs --all      # 全ステータス
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const ALL = process.argv.includes('--all')
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function get(pathq, extra = {}) {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, { headers: { ...H, ...extra } })
  if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 160)}`)
  return res
}

/** 件数だけを取りたいときは本体を返させない（Content-Range から読む） */
async function countOf(pathq) {
  const res = await get(pathq, { Prefer: 'count=exact', Range: '0-0' })
  const cr = res.headers.get('content-range') ?? ''
  return Number(cr.split('/')[1] ?? 0)
}

/** スキル集合の OR 条件。既定はワーカー／UI と同じ二本立て。
 *  --strict は skills 列のみ（本文の部分一致を使わない）＝どれだけ本文一致で緩んでいるかの計測用 */
const STRICT = process.argv.includes('--strict')
const orClauseFor = (skills) => 'or=(' + skills.flatMap((s) => (
  STRICT
    ? [`skills.cs.${encodeURIComponent(JSON.stringify([s]))}`]
    : [`skills.cs.${encodeURIComponent(JSON.stringify([s]))}`,
      `raw_profile->>text.ilike.${encodeURIComponent(`*${s}*`)}`]
)).join(',') + ')'

// --union "Java,C#" … その集合で何人ヒットするかだけを出す。
// 絞り込みは OR なので、個別の該当率ではなく和集合が実際の対象人数になる
const unionArg = process.argv.find((a) => a.startsWith('--union='))
if (unionArg) {
  const skills = unionArg.slice('--union='.length).split(',').map((s) => s.trim()).filter(Boolean)
  const base = 'candidates?select=id&data_env=eq.prod&merged_into=is.null'
  const hit = await countOf(`${base}&${orClauseFor(skills)}`)
  const all = await countOf(base)
  console.log(`対象スキル: ${skills.join(', ')}`)
  console.log(`和集合ヒット: ${hit} / ${all}件（${(hit / all * 100).toFixed(1)}%）`)
  process.exit(0)
}

const projects = await (await get(
  `projects?select=title,required_skills,status&data_env=eq.prod` +
  (ALL ? '' : '&status=eq.open') + '&limit=200')).json()

// スキル名 -> 出現案件数
const demand = new Map()
for (const p of projects) {
  for (const s of new Set((p.required_skills ?? []).map((x) => String(x).trim()).filter(Boolean))) {
    demand.set(s, (demand.get(s) ?? 0) + 1)
  }
}

const rows = []
for (const [skill, n] of demand) {
  // 人材側のヒット数。ワーカー／UI と同じ二本立ての条件で数える
  const or = `or=(skills.cs.${encodeURIComponent(JSON.stringify([skill]))},` +
    `raw_profile->>text.ilike.${encodeURIComponent(`*${skill}*`)})`
  let hits = 0
  try {
    hits = await countOf(`candidates?select=id&data_env=eq.prod&merged_into=is.null&${or}`)
  } catch { hits = -1 }
  rows.push({ skill, projects: n, candidates: hits })
}
rows.sort((a, b) => b.projects - a.projects || b.candidates - a.candidates)

const total = await countOf('candidates?select=id&data_env=eq.prod&merged_into=is.null')
const w = (s, n) => {
  const width = (t) => [...String(t)].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - width(s)))
}
console.log(`案件 ${projects.length}件（${ALL ? '全ステータス' : 'status=open'}）から必須スキルを集計`)
console.log(`prod 人材の総数: ${total}件\n`)
console.log(`${w('スキル', 30)}${w('案件数', 8)}${w('人材ヒット', 12)}該当率`)
console.log('-'.repeat(64))
for (const r of rows) {
  const pct = total && r.candidates >= 0 ? `${(r.candidates / total * 100).toFixed(1)}%` : '-'
  console.log(`${w(r.skill, 30)}${w(r.projects, 8)}${w(r.candidates < 0 ? 'エラー' : r.candidates, 12)}${pct}`)
}
