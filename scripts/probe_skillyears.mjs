#!/usr/bin/env node
/**
 * probe_skillyears.mjs — 1人の経歴書Excelを各抽出方式に通し、結果を並べて比較する
 *
 * どの方式が勝ったか・_dateSpanMonths / _totalProjectMonths が取れているかを
 * デプロイなしで確認するための調査ツール。experience_years が実態とズレるときに使う。
 *
 * 使い方:
 *   node scripts/probe_skillyears.mjs <candidate_id>
 *   node scripts/probe_skillyears.mjs <candidate_id> --skills   # スキル別月数を全部出す
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'
import {
  extractSkillYearsFromSheetData,
  extractSkillYearsUnified,
  extractSkillYearsFromCells,
} from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }

const id = process.argv[2]
const SHOW_SKILLS = process.argv.includes('--skills')
if (!id) { console.log('使い方: node scripts/probe_skillyears.mjs <candidate_id> [--skills]'); process.exit(0) }

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=name,experience_years,resume_url,age:raw_profile->age`, { headers })
const [c] = await res.json()
if (!c) { console.log('見つかりません'); process.exit(0) }
console.log(`${c.name}  DB経験年数=${c.experience_years ?? '—'}年  年齢=${c.age ?? '—'}`)
console.log(`${c.resume_url}\n`)

if (!/\.xlsx?$/i.test(String(c.resume_url).split('?')[0])) {
  console.log('Excel 以外の経歴書です（このツールは xlsx/xls 専用）'); process.exit(0)
}

const wb = XLSX.read(new Uint8Array(await (await fetch(c.resume_url)).arrayBuffer()), { type: 'array' })

const show = (label, obj) => {
  if (!obj || Object.keys(obj).length === 0) { console.log(`  ${label}: (空)`); return }
  const meta = Object.entries(obj).filter(([k]) => k.startsWith('_'))
  const skills = Object.entries(obj).filter(([k]) => !k.startsWith('_'))
  const maxM = Math.max(0, ...skills.map(([, v]) => v))
  console.log(`  ${label}: スキル${skills.length}件 最長${maxM}ヶ月(${(maxM / 12).toFixed(1)}年)  ${meta.map(([k, v]) => `${k}=${v}`).join(' ') || '内部キーなし'}`)
  if (SHOW_SKILLS) {
    for (const [k, v] of skills.sort((a, b) => b[1] - a[1])) console.log(`      ${String(k).padEnd(24)} ${v}ヶ月`)
  }
}

// worksheet → SpanCell[]（extractSkillYearsFromCells 用。結合セルを展開する）
function worksheetToCells(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const merges = ws['!merges'] ?? []
  const cells = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: col })]
      const value = cell ? String(cell.w ?? cell.v ?? '').trim() : ''
      if (!value) continue
      const m = merges.find(mm => mm.s.r === r && mm.s.c === col)
      cells.push({ row: r, col, rowSpan: m ? m.e.r - m.s.r + 1 : 1, colSpan: m ? m.e.c - m.s.c + 1 : 1, value })
    }
  }
  return cells
}

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name]
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  console.log(`=== シート「${name}」 ${data.length}行 ===`)
  try { show('方式1系 SheetData', extractSkillYearsFromSheetData(data)) } catch (e) { console.log(`  方式1系 SheetData: ERR ${e.message}`) }
  try { show('Unified          ', extractSkillYearsUnified(data)) } catch (e) { console.log(`  Unified: ERR ${e.message}`) }
  try { show('Cells(視覚)      ', extractSkillYearsFromCells(worksheetToCells(ws))) } catch (e) { console.log(`  Cells: ERR ${e.message}`) }
  console.log('')
}
