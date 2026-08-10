#!/usr/bin/env node
// audit_checked_quality.mjs — 「AI校正済み」の中身が実際に埋まっているかを検査する
//
// バッジが外れた＝校正完了だが、実際には何も抽出できていない人がいる。
// 校正済みの人を「経歴書から取れた／本文だけ／何も取れなかった」に分類し、
// 何も取れなかった人はその理由（経歴書なし・DL失敗・タイムアウト等）まで出す。
//
// 使い方: node scripts/llm_extract/audit_checked_quality.mjs [日数=2]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const DAYS = Number(process.argv[2] ?? 2)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const getAll = async (base) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${base}&limit=1000&offset=${from}`, { headers: h })
    if (!res.ok) throw new Error(`${base} -> ${res.status}`)
    const page = await res.json()
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

const cands = await getAll(`candidates?select=id,name,resume_url,` +
  `chk:raw_profile->>_llm_checked_at,pj:raw_profile->projects,sy:raw_profile->skillYears,` +
  `ap:raw_profile->_llm_applied->fields,txtlen:raw_profile->>text` +
  `&data_env=eq.prod&merged_into=is.null&created_at=gte.${since}&order=created_at.desc`)
const shadow = await getAll(`llm_shadow?select=candidate_id,source,status,reasons&created_at=gte.${since}`)
const errByCand = new Map()
for (const r of shadow) {
  if (r.status === 'error') errByCand.set(r.candidate_id, (r.reasons ?? []).join('|').slice(0, 40))
}

const checked = cands.filter((c) => c.chk)
const groups = { 経歴書あり: [], 本文のみ: [], 空: [] }
for (const c of checked) {
  const hasPj = (c.pj ?? []).length > 0
  const hasSy = Object.keys(c.sy ?? {}).filter((k) => !k.startsWith('_')).length > 0
  const applied = (c.ap ?? []).length > 0
  if (hasPj || hasSy) groups['経歴書あり'].push(c)
  else if (applied) groups['本文のみ'].push(c)
  else groups['空'].push(c)
}
const pct = (n) => (checked.length ? (n / checked.length * 100).toFixed(1) : '0.0')
console.log(`=== 「AI校正済み」の中身（prod・直近${DAYS}日）===`)
console.log(`対象: 校正済み ${checked.length}件 / 全体 ${cands.length}件`)
console.log(`  経歴書から抽出できた: ${groups['経歴書あり'].length}件（${pct(groups['経歴書あり'].length)}%）`)
console.log(`  本文の補正のみ:       ${groups['本文のみ'].length}件（${pct(groups['本文のみ'].length)}%）`)
console.log(`  何も取れなかった:     ${groups['空'].length}件（${pct(groups['空'].length)}%）`)

// 「何も取れなかった」人の理由を分類する
const reasons = new Map()
for (const c of groups['空']) {
  const err = errByCand.get(c.id)
  const r = err ? `解析エラー: ${err}`
    : !c.resume_url ? '経歴書なし（本文のみ・変更不要だった）'
      : '経歴書ありだが抽出ゼロ（要調査）'
  reasons.set(r, (reasons.get(r) ?? 0) + 1)
}
if (groups['空'].length) {
  console.log('\n何も取れなかった人の内訳:')
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}件  ${r}`)
  const suspicious = groups['空'].filter((c) => c.resume_url && !errByCand.get(c.id))
  if (suspicious.length) {
    console.log('\n要調査（経歴書があるのに抽出ゼロ）:')
    for (const c of suspicious.slice(0, 10)) console.log(`  ${c.name}  ${String(c.resume_url).split('/').pop()}`)
  }
}
