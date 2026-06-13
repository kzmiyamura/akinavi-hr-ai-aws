#!/usr/bin/env node
/**
 * debug_excel_spans.mjs — ExcelのSpanCell構造をデバッグ表示
 * 使い方: node scripts/debug_excel_spans.mjs <candidate_name_or_id>
 */
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as XLSX from 'xlsx'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dirname, '../.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim()
  }
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY

const query = process.argv[2]
if (!query) { console.log('使い方: node scripts/debug_excel_spans.mjs <名前 or ID>'); process.exit(0) }

// fetch candidate
const isUuid = /^[0-9a-f-]{36}$/.test(query)
const filter = isUuid ? `id=eq.${query}` : `name=eq.${encodeURIComponent(query)}`
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/candidates?${filter}&select=id,name,resume_url&order=created_at.desc&limit=1`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
)
const [c] = await res.json()
if (!c) { console.log('見つかりません'); process.exit(0) }
console.log(`対象: ${c.name} (${c.id})  resume_url: ${c.resume_url}`)

// fetch Excel
const storageMatch = (c.resume_url ?? '').match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/)
if (!storageMatch) { console.log('Storage URLが見つかりません'); process.exit(0) }
const fileRes = await fetch(
  `${SUPABASE_URL}/storage/v1/object/${storageMatch[1]}/${storageMatch[2]}`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
)
const buf = await fileRes.arrayBuffer()

const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
const wsName = wb.SheetNames[0]
const ws = wb.Sheets[wsName]
const data2d = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
const merges = ws['!merges'] ?? []

console.log(`\nシート: ${wsName}  merges: ${merges.length}件`)
console.log('\n=== 結合セル一覧 (先頭30件) ===')
for (const m of merges.slice(0, 30)) {
  const val = data2d[m.s.r]?.[m.s.c] ?? ''
  console.log(`  r${m.s.r}-${m.e.r} c${m.s.c}-${m.e.c}  [${String(val).slice(0, 30)}]`)
}

console.log('\n=== セルグリッド (行5〜25, 列0〜12) ===')
for (let r = 5; r <= 25 && r < data2d.length; r++) {
  const row = data2d[r] ?? []
  const cols = row.slice(0, 13).map((v, i) => {
    const s = String(v ?? '').slice(0, 10).padEnd(12)
    return `[${i}]${s}`
  })
  console.log(`r${String(r).padStart(2,'0')}: ${cols.join(' ')}`)
}
