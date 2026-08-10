#!/usr/bin/env node
// backfill_llm_checked.mjs — 校正完了フラグ(_llm_checked_at)の遡及付与＋処理遅延の計測
//
// _llm_checked_at は 2026-08-10 に導入したため、それ以前に校正済みの人材には印が無く
// UI で誤って「AI校正中」に見える。llm_shadow（処理した証跡）と _llm_applied から遡及付与する。
//
// 使い方:
//   node scripts/llm_extract/backfill_llm_checked.mjs [日数=7]           # 計測のみ
//   node scripts/llm_extract/backfill_llm_checked.mjs [日数] --apply     # 遡及付与を実行
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes('--apply')
const DAYS = Number(process.argv.filter((a) => /^\d+$/.test(a))[0] ?? 7)
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function fetchAll(q) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${q}&limit=1000&offset=${from}`, { headers: h })
    if (!res.ok) throw new Error(`${q} -> ${res.status}`)
    const page = await res.json()
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

// 処理済みの証跡: llm_shadow に行があれば処理済み（変更なしで終わった人も含む）
const shadow = await fetchAll(`llm_shadow?select=candidate_id,created_at&created_at=gte.${since}&order=created_at.asc`)
const processedAt = new Map()
for (const r of shadow) processedAt.set(r.candidate_id, r.created_at)

const cands = await fetchAll(
  `candidates?select=id,name,created_at,raw_profile&data_env=eq.prod&created_at=gte.${since}&order=created_at.asc`)

// 解析が「今の登録より後」でなければ校正済みとみなしてはいけない。
// 再解析・再登録（Box取込・dedup UPDATE）で created_at が今にリセットされる一方、
// llm_shadow には前回登録時の解析が残るため、古い解析で校正済みと誤認する
// （実害: S.N は 8/10 02:10 登録なのに校正済み印が 8/6 22:19 だった・2026-08-10）
const isFresh = (c, at) => at && new Date(at) >= new Date(c.created_at)
const targets = cands.filter((c) => !c.raw_profile?._llm_checked_at &&
  (isFresh(c, processedAt.get(c.id)) || isFresh(c, c.raw_profile?._llm_applied?.at)))
const stale = cands.filter((c) => c.raw_profile?._llm_checked_at &&
  !isFresh(c, c.raw_profile._llm_checked_at))
const stillPending = cands.filter((c) => !c.raw_profile?._llm_checked_at &&
  !isFresh(c, processedAt.get(c.id)) && !isFresh(c, c.raw_profile?._llm_applied?.at))

console.log(`=== 校正フラグの状態（prod・直近${DAYS}日・${cands.length}件）===`)
console.log(`印あり（正しい）:            ${cands.length - targets.length - stillPending.length - stale.length}件`)
console.log(`印なしだが校正済み（誤表示）: ${targets.length}件  ← 遡及付与の対象`)
console.log(`印が登録より古い（誤って済）: ${stale.length}件  ← 印を消して再校正させる対象`)
console.log(`本当に未校正（正しく校正中）: ${stillPending.length}件`)

// 未校正の滞留を時間帯で見る（ワーカーがどれだけ遅れているか）
if (stillPending.length) {
  const oldest = stillPending[0].created_at
  const lagH = (Date.now() - new Date(oldest).getTime()) / 3600000
  console.log(`\n未校正の最古: ${oldest}（${lagH.toFixed(1)}時間前）= ワーカーの遅延`)
}

if (!APPLY) { console.log(`\n（--apply で 付与${targets.length}件 / 取消${stale.length}件 を実行）`); process.exit(0) }

let ok = 0
for (const c of targets) {
  const at = isFresh(c, processedAt.get(c.id)) ? processedAt.get(c.id) : c.raw_profile._llm_applied.at
  const rp = { ...c.raw_profile, _llm_checked_at: at }
  const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
  })
  if (res.ok) ok++
}
console.log(`\n遡及付与 完了: ${ok}/${targets.length}件`)

// 登録より古い印は消す。ワーカーの本サイクルが未処理として拾い直す
let cleared = 0
for (const c of stale) {
  const rp = { ...c.raw_profile }
  delete rp._llm_checked_at
  delete rp._llm_stage
  const res = await fetch(`${URL}/rest/v1/candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
  })
  if (res.ok) cleared++
}
console.log(`古い印の取消 完了: ${cleared}/${stale.length}件`)
