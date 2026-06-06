/**
 * reprocess_no_prefecture.mjs
 * 直近7日間で nearestStation があるのに prefecture が NULL の候補者を
 * inbound-email (force=true) で再投入し、駅→都道府県を再解決する。
 *
 * Usage:
 *   node scripts/reprocess_no_prefecture.mjs [--dry-run]
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

async function main() {
  console.log(`=== reprocess_no_prefecture ${DRY_RUN ? '[DRY-RUN]' : ''} ===`)

  const since = new Date(Date.now() - DAYS * 86400 * 1000).toISOString()

  // 直近7日間を全取得してJS側でフィルタ（JSONB条件の方言を避けるため）
  const { data: all, error } = await supabase
    .from('candidates')
    .select('id, name, raw_profile')
    .eq('data_env', 'prod')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000)

  const rows = (all ?? []).filter(r =>
    r.raw_profile?.nearestStation && !r.raw_profile?.prefecture
  )

  if (error) { console.error('取得失敗:', error.message); process.exit(1) }
  if (!rows || rows.length === 0) { console.log('対象者なし。終了。'); return }

  console.log(`対象: ${rows.length} 件\n`)

  let ok = 0, ng = 0, skip = 0

  for (const row of rows) {
    const rp  = row.raw_profile ?? {}
    const text = rp.text ?? ''
    const station = rp.nearestStation ?? '(不明)'

    if (!text) {
      console.log(`  SKIP ${row.name} — raw_profile.text なし`)
      skip++
      continue
    }

    console.log(`  ${row.name} / 最寄駅: ${station}`)

    if (DRY_RUN) { ok++; continue }

    // inbound-email を force=true で再投入
    try {
      const resp = await fetch(`${EDGE_URL}/inbound-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ANON_KEY}`,
        },
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
        console.log(`    NG (${resp.status}) ${json?.error ?? ''}`)
        ng++
      } else {
        const pref = json?.candidates?.[0]?.prefecture ?? json?.prefecture ?? '?'
        console.log(`    OK → prefecture: ${pref}`)
        ok++
      }
    } catch (e) {
      console.error(`    ERROR: ${e.message}`)
      ng++
    }

    // レート制限対策
    await new Promise(r => setTimeout(r, 300))
  }

  console.log(`\n完了: OK=${ok} / NG=${ng} / SKIP=${skip}`)
}

main().catch(e => { console.error(e); process.exit(1) })
