#!/usr/bin/env node
// clear_stale_stage.mjs — 停止・クラッシュで残った AI校正の進行印を消す
//
// UI は時間で古さを推測しない方針（CandidatePage.tsx）なので、ワーカーが
// 処理中に止まると raw_profile._llm_stage が残り、動いていないのに
// 「AI校正開始/中」の表示が固まる。
//
// 同じ掃除はワーカー起動時にも走る（shadow_worker.mjs）。
// これはワーカーを起動せずに直したいときの単体版。
//
// 使い方:
//   node scripts/llm_extract/clear_stale_stage.mjs           # 対象を表示するだけ
//   node scripts/llm_extract/clear_stale_stage.mjs --apply   # 実際に消す
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes('--apply')

async function rest(pathq, opts = {}) {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return text.trim() ? JSON.parse(text) : null
}

// 'done' は完了印なので対象外。進行中を表す body / 廃止済みの sonnet だけ消す
const rows = await rest('candidates?select=id,name,created_at,raw_profile' +
  '&raw_profile->>_llm_stage=in.(body,sonnet)&order=created_at.desc&limit=200')

if (!rows?.length) {
  console.log('滞留している進行印はありません')
  process.exit(0)
}
console.log(`滞留 ${rows.length}件${APPLY ? '（消します）' : '（--apply を付けると消します）'}`)
for (const c of rows) {
  console.log(`  ${c.name ?? '(名前なし)'}  stage=${c.raw_profile?._llm_stage}  登録=${c.created_at}`)
}
if (!APPLY) process.exit(0)

let done = 0
for (const c of rows) {
  const rp = { ...(c.raw_profile || {}) }
  delete rp._llm_stage
  try {
    await rest(`candidates?id=eq.${c.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
    })
    done++
  } catch (e) { console.log(`  失敗 ${c.name}: ${String(e).slice(0, 120)}`) }
}
console.log(`消しました: ${done}/${rows.length}件`)
