#!/usr/bin/env node
// probe_pdf_text.mjs — PDF経歴書から本番と同じ手順でテキストを復元して中身を見る
//
// PDF の skillYears 取得率が Excel より極端に低い理由を、実物で確かめるための道具。
// 本番（inbound-email の extractPdfText）は Y座標で行を復元してから regex に渡す。
// ここでも同じ手順を踏まないと「本番では取れないのにローカルでは取れる」を再生産する
// （probe_skillyears で実際にやらかした。HANDOFF の「調査ツールと本番で入力が違う」参照）。
//
// PII なのでファイルには書かない。標準出力に出すだけ。
//
// 使い方:
//   node scripts/probe_pdf_text.mjs <candidate_id> [--lines 80]
//   node scripts/probe_pdf_text.mjs <candidate_id> --grep 年
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY

const args = process.argv.slice(2)
const id = args.find((a) => !a.startsWith('--'))
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const MAX = Number(arg('lines', 80))
const GREP = arg('grep', null)
if (!id) { console.error('usage: node scripts/probe_pdf_text.mjs <candidate_id> [--lines N] [--grep 語]'); process.exit(1) }

const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${id}&select=name,resume_url`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
const [row] = await res.json()
if (!row) { console.error('該当なし'); process.exit(1) }
if (!row.resume_url) { console.error('resume_url が無い'); process.exit(1) }

const pdfRes = await fetch(row.resume_url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
if (!pdfRes.ok) { console.error(`PDF取得失敗 ${pdfRes.status}: ${row.resume_url}`); process.exit(1) }
const bytes = new Uint8Array(await pdfRes.arrayBuffer())

// 本番 extractPdfText と同じ行復元（index.ts:3159-3196）
const pdf = await getDocument({ data: bytes, useSystemFonts: true }).promise
const lines = []
for (let p = 1; p <= pdf.numPages; p++) {
  const content = await (await pdf.getPage(p)).getTextContent()
  const byRow = new Map()
  for (const it of content.items) {
    const s = it.str ?? ''
    if (!s.trim()) continue
    const tr = it.transform
    if (!Array.isArray(tr) || tr.length < 6) continue
    const key = Math.round(tr[5])
    if (!byRow.has(key)) byRow.set(key, [])
    byRow.get(key).push({ x: tr[4], s })
  }
  for (const y of [...byRow.keys()].sort((a, b) => b - a)) {
    const raw = byRow.get(y).sort((a, b) => a.x - b.x).map((v) => v.s).join(' ')
    const line = raw
      .replace(/(\d)\s+([年月日])/g, '$1$2')
      .replace(/([年月])\s+(\d)/g, '$1$2')
      .replace(/(\d)\s+[\/／]\s+(\d)/g, '$1/$2')
      .trim()
    if (line) lines.push(line)
  }
}

console.log(`\n${row.name}  ${pdf.numPages}ページ / ${lines.length}行 / ${lines.join('\n').length}文字`)
console.log(`URL: ${row.resume_url}\n`)
const shown = GREP ? lines.filter((l) => l.includes(GREP)) : lines.slice(0, MAX)
if (GREP) console.log(`--- "${GREP}" を含む行: ${shown.length}件 ---`)
for (const [i, l] of shown.entries()) console.log(`${String(i).padStart(4)}| ${l}`)
if (!GREP && lines.length > MAX) console.log(`... 他 ${lines.length - MAX}行（--lines で増やす）`)
