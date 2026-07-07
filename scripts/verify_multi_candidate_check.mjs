#!/usr/bin/env node
// verify_multi_candidate.mjs の出力マニフェスト(JSON, 1行)を標準入力から受け取り、
// 各候補者の resume_url を実際にダウンロードして識別マーカーが期待通りか検証する。
// 使い方: node scripts/verify_multi_candidate.mjs | tail -1 | node scripts/verify_multi_candidate_check.mjs
import XLSX from 'xlsx'

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function getMarker(url) {
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) return `HTTP_${res.status}`
  const buf = Buffer.from(await res.arrayBuffer())
  try {
    const wb = XLSX.read(buf, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
    const markerRow = rows.find(r => r[0] === '識別マーカー')
    return markerRow ? markerRow[1] : 'MARKER_NOT_FOUND'
  } catch (e) {
    return `PARSE_ERROR:${e.message}`
  }
}

const raw = await readStdin()
const manifest = JSON.parse(raw)

// resume_url は DB から直接引く必要があるため、ここでは candidate id 一覧だけ出力し、
// 呼び出し側（Claude）が Supabase MCP で resume_url を取得して渡す2段構成にする。
console.log(JSON.stringify(manifest.flatMap(s => (s.entries ?? []).map(e => ({ scenario: s.scenario, ...e })))))
