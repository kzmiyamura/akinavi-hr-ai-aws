#!/usr/bin/env node
// audit_llm_unreadable_resumes.mjs — 「AI が読めなかった経歴書」の形を分類する
//
// llm_extract/lib.mjs の buildGridInput が null を返した経歴書（llm_shadow に
// "no date cells" で残っているもの）を集め、**今のコードで読めるか / 読めないなら何型か**を
// 数える。1つのフォーマットに対応する価値が「1件だけ」なのか「まとまった塊」なのかを
// 先に測るためのもの（2026-08-14: 想定で作ったフィクスチャが実ファイルと違い実害を出した反省）。
//
// 使い方: node scripts/audit_llm_unreadable_resumes.mjs [--limit 20]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'
import { worksheetToGrid } from './_extractors.gen.mjs'
import { buildGridInput } from './llm_extract/lib.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/(?:export\s+)?(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const li = process.argv.indexOf('--limit')
const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : 20

const rest = async (q) => {
  const r = await fetch(`${URL}/rest/v1/${q}`, { headers: H })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}

// 「日付セルなし」で落ちた記録（reasons に入る文言は run 側で固定）
const shadow = await rest('llm_shadow?select=candidate_id&source=eq.attachment&status=eq.error' +
  `&reasons=cs.%7B%22Error:%20no%20date%20cells%20in%20xlsx%22%7D&limit=${LIMIT}`)
console.log(`対象 ${shadow.length}件\n`)

const ANCHORED = /^(19|20)\d{2}[/年.\-]\d{1,2}/
const EXAMPLE = /記入例|記載例|入力例|サンプル|見本|テンプレート|sample|example|template/i
const tally = {}
const bump = (k) => { tally[k] = (tally[k] ?? 0) + 1 }

for (const s of shadow) {
  const [c] = await rest(`candidates?id=eq.${s.candidate_id}&select=name,resume_url`)
  if (!c?.resume_url) { bump('経歴書URLなし'); continue }
  let bytes
  try {
    const res = await fetch(c.resume_url)
    if (!res.ok) throw new Error(String(res.status))
    bytes = Buffer.from(await res.arrayBuffer())
  } catch (e) { bump(`ダウンロード失敗(${e.message})`); continue }

  const now = buildGridInput(bytes)
  if (now) { console.log(`  ${c.name}: ✅ 今は読める → 「${now.sheet}」(${now.dateCells})`); bump('修正で読めるようになった'); continue }

  // 読めない理由を分類する
  const wb = XLSX.read(bytes, { cellDates: true })
  let hasExample = false, yearOnly = 0, anyText = 0
  for (const sn of wb.SheetNames) {
    if (EXAMPLE.test(sn)) { hasExample = true; continue }
    const grid = worksheetToGrid(wb.Sheets[sn])
    const cells = grid.flat().map((x) => String(x).trim()).filter(Boolean)
    anyText += cells.length
    yearOnly += cells.filter((x) => /^(19|20)\d{2}$/.test(x)).length
  }
  const kind = anyText === 0 ? '本文セルが空（スキャン等）'
    : yearOnly > 0 ? '年セルはあるが月と組にならない（縦持ち・離れた列）'
    : '西暦表記が無い（和暦・期間長のみ等）'
  console.log(`  ${c.name}: ❌ ${kind}${hasExample ? '（記入例シートあり）' : ''}  年セル=${yearOnly} 全セル=${anyText}`)
  bump(kind)
}

console.log('\n=== 内訳 ===')
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}件  ${k}`)
