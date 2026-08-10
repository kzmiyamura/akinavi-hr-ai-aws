#!/usr/bin/env node
// pipeline_timeline.mjs — 1人の人材がパイプラインを流れる各段階の時刻を並べて表示する
//
// メール受信 → poll-email が拾って登録 → 本文Haiku → 添付Haiku → Sonnet昇格
// のどこで時間を使っているかを実測で示す。遅延の原因が「解析」か「順番待ち」かを見分ける用。
//
// 使い方: node scripts/llm_extract/pipeline_timeline.mjs [人数=6]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const N = Number(process.argv[2] ?? 6)
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const get = async (q) => {
  const res = await fetch(`${URL}/rest/v1/${q}`, { headers: h })
  if (!res.ok) throw new Error(`${q} -> ${res.status}`)
  return res.json()
}

// 直近に処理された人材を llm_shadow から拾う（新しい順に候補者単位でまとめる）
const shadow = await get('llm_shadow?select=candidate_id,source,model,ms,created_at&order=created_at.desc&limit=200')
const byCand = new Map()
for (const r of shadow) {
  if (!byCand.has(r.candidate_id)) byCand.set(r.candidate_id, [])
  byCand.get(r.candidate_id).push(r)
}
const ids = [...byCand.keys()].slice(0, N)
const cands = await get(`candidates?select=id,name,created_at,recv:raw_profile->>emailReceivedAt&id=in.(${ids.join(',')})`)
const candById = new Map(cands.map((c) => [c.id, c]))

const jst = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(11, 16) : '  —  ')
const mins = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null)
const pad = (v, n) => String(v ?? '—').padStart(n)

console.log('人材      受信   登録   本文H  添付H  Sonnet | 受信→登録 登録→解析開始 解析所要 受信→完了')
console.log('-'.repeat(96))
for (const id of ids) {
  const c = candById.get(id)
  if (!c) continue
  const rows = byCand.get(id)
  const body = rows.find((r) => r.source === 'body')
  const att = rows.filter((r) => r.source === 'attachment')
  const haikuAtt = att.find((r) => r.model === 'haiku')
  const sonnet = att.find((r) => r.model === 'sonnet')
  const last = rows.map((r) => r.created_at).sort().at(-1)
  // llm_shadow.created_at は「その解析が終わった時刻」。開始は ms を引いて求める
  const firstStart = body ? new Date(new Date(body.created_at) - (body.ms ?? 0)).toISOString() : null
  console.log(
    `${(c.name ?? '').slice(0, 8).padEnd(9)}` +
    `${jst(c.recv)}  ${jst(c.created_at)}  ${jst(body?.created_at)}  ${jst(haikuAtt?.created_at)}  ${jst(sonnet?.created_at)} |` +
    `${pad(mins(c.recv, c.created_at), 8)}分${pad(mins(c.created_at, firstStart), 11)}分` +
    `${pad(mins(firstStart, last), 8)}分${pad(mins(c.recv, last), 9)}分`,
  )
}
console.log('\n※ 本文H/添付H/Sonnet はその解析が「終わった」時刻（JST）')
console.log('※ 同じ人材の 本文H→添付H→Sonnet は同じ処理枠で連続実行される（別々の行列ではない）')
