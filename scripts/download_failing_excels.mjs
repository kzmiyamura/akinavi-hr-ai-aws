/**
 * skillYearsが取れていないStorage ExcelをローカルのtestDataに保存する
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)

const { data } = await supabase
  .from('candidates')
  .select('id, name, resume_url, raw_profile')
  .eq('data_env', 'prod')
  .gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString())
  .not('resume_url', 'is', null)
  .order('created_at', { ascending: false })
  .limit(300)

const targets = (data ?? []).filter(r => {
  if (!r.resume_url?.includes('supabase.co/storage')) return false
  if (!/\.(xlsx?|xls)$/i.test(r.resume_url)) return false
  const sy = r.raw_profile?.skillYears ?? {}
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
