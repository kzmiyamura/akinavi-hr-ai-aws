#!/usr/bin/env node
// audit_bad_names.mjs — 氏名として成立していないレコードを洗い出す
//
// 一覧に「オープン系」「昭和３３年５月１３日」等が氏名として並ぶと、
// それだけで製品の信頼を失う（2026-08-10 ユーザー指摘）。
// 誰が見ても人名でないものを機械的に拾い、件数と内訳を出す。
//
// 使い方: node scripts/audit_bad_names.mjs [--json]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`, { headers: H })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

/** 氏名として成立しない理由を返す（空配列なら問題なし） */
export function badNameReasons(name) {
  const s = String(name ?? '').trim()
  const r = []
  if (!s) return ['空']
  // 全角数字を含む（生年月日・年齢の巻き込み）。JSの \d は全角にマッチしないため個別に見る
  if (/[０-９]/.test(s)) r.push('全角数字')
  if (/\d/.test(s)) r.push('半角数字')
  // 元号つきの日付
  if (/(昭和|平成|令和|大正)/.test(s)) r.push('元号(生年月日)')
  // スキル分類・工程・属性のラベル
  if (/(オープン系|汎用系|制御系|組込|インフラ|ネットワーク|サーバ|アプリ|開発系|運用系)$/.test(s)) r.push('スキル分類')
  if (/^(不明|未定|なし|該当なし|要員|人材|エンジニア|技術者|氏名|名前)$/.test(s)) r.push('プレースホルダ')
  // 記号のみ・極端に長い
  if (!/[A-Za-zＡ-Ｚａ-ｚぁ-んァ-ヶ一-龥]/.test(s)) r.push('文字なし')
  if (s.length > 20) r.push(`長すぎる(${s.length}字)`)
  return r
}

if (process.argv[1]?.endsWith('audit_bad_names.mjs')) {
  const rows = await fetchAll(
    'candidates?select=id,name,created_at,checked:raw_profile->>_llm_checked_at' +
    '&data_env=eq.prod&merged_into=is.null&order=created_at.desc')
  const bad = []
  for (const c of rows) {
    const reasons = badNameReasons(c.name)
    if (reasons.length) bad.push({ ...c, reasons: reasons.join('/') })
  }
  const byReason = new Map()
  for (const b of bad) byReason.set(b.reasons, (byReason.get(b.reasons) ?? 0) + 1)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(bad, null, 1))
  } else {
    console.log(`prod 人材 ${rows.length}件中、氏名が成立していない ${bad.length}件` +
      `（${(bad.length / rows.length * 100).toFixed(1)}%）\n`)
    console.log('理由別:')
    for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}件  ${k}`)
    }
    console.log('\n例（新しい順に20件）:')
    for (const b of bad.slice(0, 20)) {
      console.log(`  ${(b.name ?? '').padEnd(24)} [${b.reasons}] ${b.checked ? 'AI校正済' : 'AI校正待ち'}`)
    }
  }
}
