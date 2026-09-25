#!/usr/bin/env node
/**
 * ワーカーの取得条件に足した「控え待ち」句が、本当に意図どおり効くかを確かめる（2026-09-26）。
 *
 * ■ なぜ確かめるか
 *   PostgREST の `or=(...)` は書き方を間違えると 400 を返す。
 *   ワーカーの取得クエリが落ちると **AI校正が丸ごと止まる**。
 *   デプロイ前に本物のAPIに1回だけ聞いて、通ること・件数が減ることを見る。
 *
 * ■ 転送量
 *   すべて HEAD + Prefer: count=exact。本体は1行も受け取らない。
 *
 * 実行: node scripts/llm_extract/verify_archive_grace.mjs [--grace 20]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const env = {}
for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!m) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  env[m[1]] = v
}
const BASE = env.SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_KEY

const gi = process.argv.indexOf('--grace')
const GRACE = gi >= 0 ? Number(process.argv[gi + 1]) : 20

const since = new Date(Date.now() - 7 * 86400000).toISOString()
const graceAt = new Date(Date.now() - GRACE * 60000).toISOString()

const common = `candidates?select=id&data_env=eq.prod&merged_into=is.null` +
  `&raw_profile->>_llm_checked_at=is.null` +
  `&created_at=gte.${encodeURIComponent(since)}`

const graceClause = `&or=(resume_url.is.null,created_at.lte.${encodeURIComponent(`"${graceAt}"`)})`

/** 本体を受け取らずに件数だけ数える */
async function count(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}&limit=1`, {
    method: 'HEAD',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const cr = res.headers.get('content-range') || ''
  return { n: Number(cr.split('/')[1]) }
}

const before = await count(common)
const after = await count(common + graceClause)
// 経歴書を持つ人だけが遅れる、という意図どおりかを別途確認する
const freshWithResume = await count(
  `${common}&resume_url=not.is.null&created_at=gt.${encodeURIComponent(graceAt)}`)

console.log(`控え待ち: ${GRACE} 分（${graceAt}）`)
console.log('')
if (before.error || after.error) {
  console.error(`✗ クエリが通りませんでした（条件なし=${before.error ?? 'OK'} / 条件あり=${after.error ?? 'OK'}）`)
  console.error('  この状態で本番に入れると AI校正が止まります。')
  process.exit(1)
}
console.log(`条件なしの対象         : ${before.n} 人`)
console.log(`控え待ちを足した対象   : ${after.n} 人`)
console.log(`除外された             : ${before.n - after.n} 人`)
console.log(`うち「経歴書あり かつ ${GRACE}分以内」: ${freshWithResume.n ?? '—'} 人`)
console.log('')

if (before.n - after.n !== freshWithResume.n) {
  console.error('✗ 除外された人数が「経歴書あり かつ新しい」と一致しません。条件が意図どおりではありません。')
  process.exit(1)
}
console.log('✓ クエリは通り、除外されたのは「経歴書を持つ新しい人」だけでした。')
