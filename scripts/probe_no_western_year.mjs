#!/usr/bin/env node
// probe_no_western_year.mjs — 「西暦セルが1つも無い」経歴書に何が書いてあるかを見る
//
// AIが読めない残り4件（AN / TK / MK / I.Y）は年セル=0。和暦なのか期間長なのか、
// それとも別の何かなのかを**実装の前に**確かめる（2026-08-14 の教訓）。
//
// 使い方: node scripts/probe_no_western_year.mjs <candidate_id...>
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'
import { worksheetToGrid } from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/(?:export\s+)?(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const rest = async (q) => {
  const r = await fetch(`${URL}/rest/v1/${q}`, { headers: H })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}

// 期間らしさの候補パターン
const PATTERNS = [
  ['和暦（令和・平成・R5.11 等）', /(令和|平成|昭和|[RHS]\s?\d{1,2})\s*[.\-/年]?\s*\d{0,2}/],
  ['期間長（2年0ヶ月）', /\d{1,2}\s*年\s*\d{1,2}\s*[ヶか箇]?月/],
  ['月数のみ（12ヶ月）', /\d{1,3}\s*[ヶか箇]月/],
  ['西暦2桁（23/11・23年11月）', /(^|[^\d])\d{2}\s*[./年]\s*\d{1,2}([^\d]|$)/],
  ['〜で結ぶ期間', /[~〜～]/],
]

for (const id of process.argv.slice(2)) {
  const [c] = await rest(`candidates?id=eq.${id}&select=name,resume_url`)
  if (!c?.resume_url) { console.log(`\n### ${id}: 経歴書なし`); continue }
  let wb
  try {
    wb = XLSX.read(Buffer.from(await (await fetch(c.resume_url)).arrayBuffer()), { cellDates: true })
  } catch (e) { console.log(`\n### ${c.name}: ダウンロード失敗 ${e.message}`); continue }

  console.log(`\n### ${c.name}  シート: ${wb.SheetNames.join(' / ')}`)
  for (const sn of wb.SheetNames) {
    const grid = worksheetToGrid(wb.Sheets[sn])
    const cells = grid.flat().map((x) => String(x).trim()).filter(Boolean)
    if (!cells.length) continue
    const hits = PATTERNS.map(([label, re]) => [label, cells.filter((x) => re.test(x)).length])
      .filter(([, n]) => n > 0)
    console.log(`  「${sn}」 セル${cells.length}  ${hits.map(([l, n]) => `${l}:${n}`).join('  ') || '（該当パターンなし）'}`)
    // 期間らしいセルの実物（短いものだけ・PII を避ける）
    const sample = cells.filter((x) => x.length <= 20 && PATTERNS.some(([, re]) => re.test(x)))
    if (sample.length) console.log('    例:', [...new Set(sample)].slice(0, 10).join(' / '))
  }
}
