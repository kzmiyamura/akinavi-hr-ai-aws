import { readFileSync } from 'fs'
import XLSX from 'xlsx'
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
  const realKeys = Object.keys(sy).filter(k => !k.startsWith('_'))
  return realKeys.length === 0
}).slice(0, 8)

console.log(`失敗ケース: ${targets.length}件\n`)

for (const row of targets) {
  console.log(`=== ${row.name} ===`)
  try {
    const resp = await fetch(row.resume_url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) { console.log(`HTTP ${resp.status}\n`); continue }
    const buf = await resp.arrayBuffer()
    const wb = XLSX.read(Buffer.from(buf), { type: 'buffer' })
    
    const sheetName = wb.SheetNames[0]
    const ws = wb.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    
    // ヘッダー行を探す
    let headerRow = -1
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const cells = rows[i].map(c => String(c ?? '').split(/[\r\n]/)[0].trim())
      const joined = cells.join('|')
      if (/使用言語|言語|使用技術|技術スタック/.test(joined)) {
        headerRow = i
        console.log(`  ヘッダー行${i}: ${cells.slice(0, 10).join(' | ')}`)
        break
      }
    }
    if (headerRow < 0) {
      console.log(`  ヘッダーなし — 上位10行:`)
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const cells = rows[i].map(c => String(c ?? '').split(/[\r\n]/)[0].trim())
        if (cells.some(c => c)) console.log(`    行${i}: ${cells.slice(0, 8).join(' | ')}`)
      }
    } else {
      // プロジェクト行サンプル
      let shown = 0
      for (let i = headerRow + 1; i < Math.min(rows.length, headerRow + 30) && shown < 3; i++) {
        const cells = rows[i].map(c => String(c ?? '').split(/[\r\n]/)[0].trim())
        const first = cells[0]
        if (first && /^\d+$/.test(first.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0)-0xFEE0)))) {
          console.log(`  プロジェクト行${i}: ${cells.slice(0, 9).join(' | ')}`)
          // 次3行（期間行を探す）
          for (let di = 1; di <= 4; di++) {
            if (i + di >= rows.length) break
            const nc = rows[i + di].map(c => String(c ?? '').split(/[\r\n]/)[0].trim())
            if (nc.some(c => c)) console.log(`    +${di}行: ${nc.slice(0, 6).join(' | ')}`)
          }
          shown++
        }
      }
    }
  } catch(e) { console.log(`エラー: ${e.message}`) }
  console.log()
}
