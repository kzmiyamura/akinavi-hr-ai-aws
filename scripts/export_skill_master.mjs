#!/usr/bin/env node
/**
 * export_skill_master.mjs — skill_master(DB) を JSON に書き出し、
 * supabase/functions/inbound-email/skill_master_data.json に配置する。
 *
 * ⚠ なぜ同梱するのか（2026-08-19・egress 対策）
 * inbound-email はメール処理のたびに skill_master 全件（952行・**1回131KB**）を
 * DB から読んでいた。モジュールスコープの5分キャッシュはあるが、
 * Edge Function のインスタンスが頻繁に作り直されるため効いておらず、
 * ログ実測で **1時間に124回**＝**1日あたり約382MB**。
 * これは PostgREST egress（190〜220MB/日）の大半を説明する量だった。
 * station_master と同じくビルド時同梱に切り替える。
 *
 * 実行時は「件数だけ」を HEAD で確認し、同梱データと件数が違うときだけ DB から取り直す。
 * これでスキルを追加したときは再デプロイ前でも自動的に反映される。
 * **別名（aliases）だけを編集した場合は件数が変わらないので反映されない。**
 * その場合はこのスクリプトを再実行してデプロイすること（station_master と同じ運用）。
 *
 * Usage: node scripts/export_skill_master.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function loadEnv() {
  const envPath = resolve(ROOT, '.env.local')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim()
    if (!process.env[k]) process.env[k] = v
  }
}
loadEnv()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ANON_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です（.env.local を確認）')
  process.exit(1)
}

const headers = { apikey: ANON_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
const entries = []
for (let from = 0; ; from += 1000) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/skill_master?select=id,name,category,aliases&order=id&limit=1000&offset=${from}`,
    { headers },
  )
  if (!res.ok) {
    console.error(`ERROR: skill_master の取得に失敗しました: HTTP ${res.status}`)
    process.exit(1)
  }
  const rows = await res.json()
  entries.push(...rows)
  if (rows.length < 1000) break   // PostgREST は1000行で切るので回して集める
}

const out = resolve(ROOT, 'supabase/functions/inbound-email/skill_master_data.json')
const payload = { count: entries.length, exportedAt: new Date().toISOString(), entries }
writeFileSync(out, JSON.stringify(payload), 'utf-8')

const kb = (JSON.stringify(payload).length / 1024).toFixed(1)
console.log(`✅ skill_master ${entries.length}件を書き出しました（${kb}KB）`)
console.log(`   ${out}`)
console.log('   デプロイ: bash scripts/check-and-deploy-edge.sh inbound-email')
