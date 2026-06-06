/**
 * reprocess_no_skill_years.mjs
 * 直近7日間で drive_url/resume_url があるのに skillYears が取れていない候補者を
 * inbound-email (force=true) で再投入し、新しい HTML→JSON 抽出ロジックを適用する。
 *
 * Usage:
 *   node scripts/reprocess_no_skill_years.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim()
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY
const EDGE_URL     = `${SUPABASE_URL}/functions/v1`
const supabase     = createClient(SUPABASE_URL, ANON_KEY)
const DRY_RUN      = process.argv.includes('--dry-run')
const DAYS         = 7
const CONCURRENCY  = 5

async function main() {
  console.log(`=== reprocess_no_skill_years ${DRY_RUN ? '[DRY-RUN]' : ''} ===`)

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString()

  const { data: all, error } = await supabase
    .from('candidates')
    .select('id, name, drive_url, resume_url, raw_profile')
    .eq('data_env', 'prod')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000)

  if (error) { console.error('取得失敗:', error.message); process.exit(1) }

  // drive_url または resume_url があって skillYears が空の候補者
  const rows = (all ?? []).filter(r => {
    if (!r.drive_url && !r.resume_url) return false
    const sy = r.raw_profile?.skillYears ?? {}
    const realKeys = Object.keys(sy).filter(k => !k.startsWith('_'))
    return realKeys.length === 0
  })

  if (rows.length === 0) { console.log('対象者なし。終了。'); return }
  console.log(`対象: ${rows.length} 件\n`)

  let ok = 0, ng = 0, skip = 0

  async function processOne(row) {
    const rp   = row.raw_profile ?? {}
    const text = rp.text ?? ''
    if (!text) {
      console.log(`  SKIP ${row.name} — raw_profile.text なし`)
      skip++
      return
    }
    if (DRY_RUN) {
      const url = row.drive_url ?? row.resume_url ?? ''
      console.log(`  [DRY] ${row.name} | ${url.slice(0, 60)}`)
      ok++
      return
    }
    try {
      const resp = await fetch(`${EDGE_URL}/inbound-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}` },
        body: JSON.stringify({
          force: true,
          data_env: 'prod',
          subject: rp.subject ?? '再解析',
          from:    rp.from    ?? '',
          body:    text,
        }),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok || json?.ok === false) {
        console.log(`  NG  ${row.name} (${resp.status}) ${json?.error ?? ''}`)
        ng++
      } else {
        ok++
      }
    } catch (e) {
      console.error(`  ERR ${row.name}: ${e.message}`)
      ng++
    }
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY)
    await Promise.all(chunk.map(r => processOne(r)))
    console.log(`進捗: ${Math.min(i + CONCURRENCY, rows.length)} / ${rows.length}`)
  }

  console.log(`\n完了: OK=${ok} / NG=${ng} / SKIP=${skip}`)
}

main().catch(e => { console.error(e); process.exit(1) })
