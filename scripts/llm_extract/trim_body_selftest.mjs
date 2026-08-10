#!/usr/bin/env node
// trim_body_selftest.mjs — trimBodyForLlm の単体テスト＋実データでの削減率計測
//
// 実行: node scripts/llm_extract/trim_body_selftest.mjs        # 単体テスト
//       node scripts/llm_extract/trim_body_selftest.mjs --real # 実データ50件で削減率を測る
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// shadow_worker は env 必須のため、同じ実装をここに複製せず読み込みだけ行う
process.env.SUPABASE_URL ??= 'http://dummy'
process.env.SUPABASE_SERVICE_KEY ??= 'dummy'
const { trimBodyForLlm } = await import('./shadow_worker_lib.mjs')

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) pass++
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)}\n    exp=${JSON.stringify(expect)}`) }
}

const head = 'ご担当者様\n【氏名】A.B（30歳・男性）\n【最寄】新宿駅\n【単価】60万円\n'.padEnd(320, '　')
// 「本文は残り、定型文以降は消える」ことを確認する（末尾の改行有無は問わない）
const kept = (input, dropped) => {
  const r = trimBodyForLlm(input)
  return r.includes('【単価】60万円') && !r.includes(dropped)
}
t('署名区切り以降を落とす', kept(head + '\n--------------------\n株式会社X 山田\nTEL 03-0000', '株式会社X 山田'), true)
t('配信停止以降を落とす', kept(head + '\n配信停止をご希望の方はこちら', '配信停止'), true)
t('法務定型文以降を落とす', kept(head + '\n【重要：要員情報の利用範囲および利益帰属について】\n本メール…', '利益帰属'), true)
t('URLは置換する', trimBodyForLlm('【氏名】A.B\nhttps://example.com/aaa/bbb 参照'), '【氏名】A.B\n(URL) 参照')
t('短い本文はそのまま', trimBodyForLlm('【氏名】A.B'), '【氏名】A.B')
t('上限6000字で切る', trimBodyForLlm('あ'.repeat(9000)).length, 6000)
console.log(`\n📊 ${pass} passed / ${fail} failed`)

if (!process.argv.includes('--real')) process.exit(fail ? 1 : 0)

// ── 実データでの削減率 ──
for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m) process.env[m[1]] = m[2].trim()
}
const rows = await (await fetch(
  `${process.env.SUPABASE_URL}/rest/v1/candidates?select=name,txt:raw_profile->>text&data_env=eq.prod&order=created_at.desc&limit=50`,
  { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } })).json()
let before = 0, after = 0
for (const r of rows) {
  const b = String(r.txt ?? '')
  if (b.length < 50) continue
  before += Math.min(b.length, 8000)   // 旧実装は 8000字上限
  after += trimBodyForLlm(b).length
}
console.log(`\n実データ${rows.length}件の本文長: ${before.toLocaleString()} → ${after.toLocaleString()}字` +
  `（${((1 - after / before) * 100).toFixed(0)}%削減）`)
