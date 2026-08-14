#!/usr/bin/env node
// seed_demo_candidate.mjs — 検証用の人材を demo（検証データマーク）で1件作る
//
// 目的は egress の節約。検証のたびに prod（人材1,521件）を引くのをやめ、
// **再現したいケースだけを自分で作って demo に置く**（2026-08-14 ユーザー方針）。
// demo は人材53件しかないので、画面確認1回の転送量が prod の数十分の一で済む。
//
// 本番と同じ経路（inbound-email に force:true で POST）を通すので、
// regex 抽出・skill_master 照合・駅名正規化まで本番とまったく同じ処理が走る。
// 手動登録の UI が投げているのと同じリクエストで、prod には一切触れない。
//
// 使い方:
//   node scripts/seed_demo_candidate.mjs --body <本文ファイル> [--subject "件名"]
//                                        [--from a@demo.invalid] [--attach <経歴書パス>]
//
// 例（年月が別セルの記入フォーム型を再現する）:
//   node scripts/seed_demo_candidate.mjs --body scripts/testData/demo/form_style.txt \
//        --attach scripts/testData/demo/form_style.xlsx
//
// 後片付けは SQL 側で（egress ゼロ）:
//   delete from candidates where data_env='demo' and raw_profile->>'from' like '%@demo.invalid';
import { readFileSync } from 'fs'
import { basename } from 'path'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/(?:export\s+)?(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('~/.akinavi_shadow.env が読めません'); process.exit(1) }

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const bodyPath = arg('body')
if (!bodyPath) {
  console.error('使い方: node scripts/seed_demo_candidate.mjs --body <本文ファイル> ' +
    '[--subject "件名"] [--from a@demo.invalid] [--attach <経歴書>]')
  process.exit(1)
}
const body = readFileSync(bodyPath, 'utf8')
const subject = arg('subject', '【検証データ】人材ご紹介')
// demo.invalid は inbound-email 側で「所属会社として採用しない」既知ドメイン。
// 検証データが実在企業名を持たないようにするため既定でこれを使う
const from = arg('from', 'seed@demo.invalid')

const attachments = []
const attachPath = arg('attach')
if (attachPath) {
  const buf = readFileSync(attachPath)
  const ext = attachPath.toLowerCase().split('.').pop()
  const mime = ext === 'xlsx' || ext === 'xlsm'
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream'
  attachments.push({ data: buf.toString('base64'), mimeType: mime, name: basename(attachPath) })
}

const res = await fetch(`${URL}/functions/v1/inbound-email`, {
  method: 'POST',
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  // mode:'demo' が検証データマーク（data_env='demo'）。**prod には絶対に書かない**
  body: JSON.stringify({ subject, body, from, attachments, mode: 'demo', type: 'candidate', force: true }),
})
const json = await res.json().catch(() => ({}))
if (!res.ok) { console.error(`❌ HTTP ${res.status}`, JSON.stringify(json).slice(0, 400)); process.exit(1) }
console.log(`✅ demo に登録しました（添付${attachments.length}件）`)
console.log(JSON.stringify(json).slice(0, 600))
console.log('\n確認: node scripts/llm_extract/sb-query.mjs ' +
  '"candidates?select=id,name,skills&data_env=eq.demo&order=created_at.desc&limit=3"')
