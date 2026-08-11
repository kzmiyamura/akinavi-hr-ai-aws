/**
 * skillYearsが取れていないStorage ExcelをローカルのtestDataに保存する
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
// CRLF の .env.local だと `.` が \r にマッチせず `$`（文字列末尾）に届かないため
// 1行も読めずに env が空になる（Windows で実害・2026-08-10）。改行で分割してから照合する
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)

// raw_profile を丸ごと取ると1件約35KB（attachmentText を含む）で、300件では約10MBになる。
// 判定に要るのは skillYears だけなので JSON パスで絞る（2026-08-12・egress 対策）
const { data } = await supabase
  .from('candidates')
  .select('id, name, resume_url, sy:raw_profile->skillYears')
  .eq('data_env', 'prod')
  .gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString())
  .not('resume_url', 'is', null)
  .order('created_at', { ascending: false })
  .limit(300)

const targets = (data ?? []).filter(r => {
  if (!r.resume_url?.includes('supabase.co/storage')) return false
  if (!/\.(xlsx?|xls)$/i.test(r.resume_url)) return false
  const sy = r.sy ?? {}
  return Object.keys(sy).filter(k => !k.startsWith('_')).length === 0
}).slice(0, 10)

const dir = 'scripts/testData/excel'
mkdirSync(dir, { recursive: true })

for (const row of targets) {
  const ext = row.resume_url.split('.').pop().toLowerCase()
  const safeName = (row.name ?? 'unknown').replace(/[^\w\u3040-\u9FFF]/g, '_')
  const filename = `${dir}/${safeName}.${ext}`
  try {
    const resp = await fetch(row.resume_url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) { console.log(`SKIP ${row.name}: HTTP ${resp.status}`); continue }
    const buf = await resp.arrayBuffer()
    writeFileSync(filename, Buffer.from(buf))
    console.log(`OK  ${row.name} → ${filename}`)
  } catch(e) {
    console.log(`ERR ${row.name}: ${e.message}`)
  }
}
