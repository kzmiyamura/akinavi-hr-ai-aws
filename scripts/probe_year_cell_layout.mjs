#!/usr/bin/env node
// probe_year_cell_layout.mjs — 「年セルはあるが月と組にならない」経歴書の実際の並びを見る
//
// 2026-08-14 の教訓: 実ファイルの形を見ずに想定でフィクスチャを作り、
// 記入例シートへ落ちる経路を踏まないテストを書いて実害を出した。
// **実装の前に、まず実物の並びを数える。**
//
// 使い方: node scripts/probe_year_cell_layout.mjs <candidate_id...>
//         node scripts/probe_year_cell_layout.mjs --from-shadow   # 失敗記録から自動で集める
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

const EXAMPLE = /記入例|記載例|入力例|サンプル|見本|テンプレート|sample|example|template/i
const isYear = (s) => /^(19|20)\d{2}$/.test(String(s).trim())
const isMonth = (s) => { const v = String(s).trim(); return /^\d{1,2}$/.test(v) && +v >= 1 && +v <= 12 }

let ids = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (process.argv.includes('--from-shadow')) {
  const rows = await rest('llm_shadow?select=candidate_id&source=eq.attachment&status=eq.error' +
    '&reasons=cs.%7B%22Error:%20no%20date%20cells%20in%20xlsx%22%7D&limit=20')
  ids = rows.map((r) => r.candidate_id)
}

for (const id of ids) {
  const [c] = await rest(`candidates?id=eq.${id}&select=name,resume_url`)
  if (!c?.resume_url || !/\.xlsx?$/i.test(c.resume_url)) continue
  let wb
  try {
    wb = XLSX.read(Buffer.from(await (await fetch(c.resume_url)).arrayBuffer()), { cellDates: true })
  } catch { console.log(`\n### ${c.name}: ダウンロード失敗`); continue }

  for (const sn of wb.SheetNames) {
    if (EXAMPLE.test(sn)) continue
    const grid = worksheetToGrid(wb.Sheets[sn])
    const years = []
    grid.forEach((row, r) => row.forEach((v, col) => { if (isYear(v)) years.push([r, col]) }))
    if (!years.length) continue
    console.log(`\n### ${c.name} / シート「${sn}」 年セル${years.length}個`)
    // 年セルから見て「月」がどの位置にあるかを数える（右にn / 下にn / 見つからない）
    const where = {}
    for (const [r, col] of years) {
      let found = null
      for (let d = 1; d <= 6 && !found; d++) if (isMonth(grid[r]?.[col + d])) found = `右${d}`
      for (let d = 1; d <= 3 && !found; d++) if (isMonth(grid[r + d]?.[col])) found = `下${d}`
      where[found ?? '見つからない'] = (where[found ?? '見つからない'] ?? 0) + 1
    }
    console.log('  月の位置:', JSON.stringify(where))
    // 年セルを含む行の実物を数行だけ出す（PIIを避けるため先頭120文字）
    const shown = new Set()
    for (const [r] of years.slice(0, 4)) {
      if (shown.has(r)) continue
      shown.add(r)
      console.log(`   r${r}: ${grid[r].map((x) => String(x)).join(' | ').slice(0, 120)}`)
    }
  }
}
