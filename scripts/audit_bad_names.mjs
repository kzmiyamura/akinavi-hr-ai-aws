#!/usr/bin/env node
// audit_bad_names.mjs — 氏名として成立していないレコードを洗い出す
//
// 一覧に「オープン系」「昭和３３年５月１３日」等が氏名として並ぶと、
// それだけで製品の信頼を失う（2026-08-10 ユーザー指摘）。
// 誰が見ても人名でないものを機械的に拾い、件数と内訳を出す。
//
// 使い方: node scripts/audit_bad_names.mjs [--json]
//
// ⚠ これは prod を全件ページングする。日常的に回すなら
//   `node scripts/selfcheck/run.mjs`（控えで回る検出器⑤・egress ゼロ）を使う。
//   判定規則は両方が scripts/lib/bad_names.mjs を共有する（書き写すとズレる）。
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { badNameReasons } from './lib/bad_names.mjs'

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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathq}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
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
