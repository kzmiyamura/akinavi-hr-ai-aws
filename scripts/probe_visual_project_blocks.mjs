#!/usr/bin/env node
// probe_visual_project_blocks.mjs — 視覚エンジン（案件ブロックunion・_extractMethod=61）を
// ブロック単位で分解して見る
//
// skillYears が実際の経験年数を大きく超えたとき、どの案件ブロックのどの期間テキストが
// 原因かを特定するための道具。ブロックの行範囲・期間テキスト・解決した開始/終了/期間長を出す。
//
// 本番と同じ読み込み（cellDates: true）・同じ worksheetToCells を使う。
//
// 使い方: node scripts/probe_visual_project_blocks.mjs <candidate_id>
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as XLSX from 'xlsx'
import {
  worksheetToCells, extractSkillYearsVisualProject, projParsePeriod, projParseKakko,
} from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const id = process.argv[2]
if (!id) { console.error('usage: node scripts/probe_visual_project_blocks.mjs <candidate_id>'); process.exit(1) }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const [row] = await (await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=name,resume_url,experience_years`, { headers: H })).json()
const buf = new Uint8Array(await (await fetch(row.resume_url, { headers: H })).arrayBuffer())
const wb = XLSX.read(buf, { cellDates: true })
const nowMonth = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
const fmt = (mi) => mi == null ? '—' : `${Math.floor((mi - 1) / 12)}/${((mi - 1) % 12) + 1}`

console.log(`\n${row.name}  DB経験年数=${row.experience_years}年`)
for (const name of wb.SheetNames) {
  const cells = worksheetToCells(wb.Sheets[name])
  const res = extractSkillYearsVisualProject(cells)
  console.log(`\n=== ${name}: cells=${cells.length} → ${res ? Object.keys(res).length + '件' : 'null（信頼ゲートで不採用）'} ===`)
  if (res) {
    const top = Object.entries(res).sort((a, b) => b[1] - a[1]).slice(0, 12)
    for (const [k, v] of top) console.log(`   ${k.padEnd(18)} ${String(v).padStart(4)}ヶ月 (${(v / 12).toFixed(1)}年)`)
  }
  // 期間として解釈されうるセルを全部出す（どこから長い期間が来たかの特定用）
  console.log(`   --- 期間として解決したセル ---`)
  for (const c of cells) {
    if (!c.value || !c.value.trim()) continue
    const { start, end, dur } = projParsePeriod(c.value, nowMonth)
    if (start === null && dur === null) continue
    const span = (start !== null && end !== null) ? `${fmt(start)}〜${fmt(end)} = ${end - start + 1}ヶ月` : ''
    console.log(`   r${String(c.row).padStart(3)} c${String(c.col).padStart(2)} ${span}${dur !== null ? ` dur=${dur}ヶ月` : ''}  "${c.value.replace(/\s+/g, ' ').slice(0, 48)}"`)
  }
}
