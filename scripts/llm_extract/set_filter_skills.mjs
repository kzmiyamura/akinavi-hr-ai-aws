#!/usr/bin/env node
// set_filter_skills.mjs — AI校正の優先スキル（app_config.llm_filter_skills）を設定する
//
// 設定画面からも変更できるが、CLI から確実に入れたいとき用。
// 空にすると絞り込み解除（全員が対象）に戻る。
//
// この設定はワーカーのAI校正対象と人材一覧の初期表示の両方に効く。
//
// 使い方:
//   node scripts/llm_extract/set_filter_skills.mjs                 # 現在値を表示
//   node scripts/llm_extract/set_filter_skills.mjs Java C#         # 設定
//   node scripts/llm_extract/set_filter_skills.mjs --clear         # 絞り込み解除
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function current() {
  const res = await fetch(`${URL}/rest/v1/app_config?select=value&key=eq.llm_filter_skills`, { headers: H })
  const rows = await res.json()
  let v = rows?.[0]?.value
  for (let i = 0; i < 2 && typeof v === 'string'; i++) { try { v = JSON.parse(v) } catch { break } }
  return Array.isArray(v) ? v : null
}

/** 該当人数を数える（ワーカー・UI と同じ二本立ての条件） */
async function countMatching(skills) {
  const base = 'candidates?select=id&data_env=eq.prod&merged_into=is.null'
  const or = skills.length
    ? '&or=(' + skills.flatMap((s) => [
      `skills.cs.${encodeURIComponent(JSON.stringify([s]))}`,
      `raw_profile->>text.ilike.${encodeURIComponent(`*${s}*`)}`,
    ]).join(',') + ')'
    : ''
  const res = await fetch(`${URL}/rest/v1/${base}${or}`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } })
  return Number((res.headers.get('content-range') ?? '').split('/')[1] ?? 0)
}

const args = process.argv.slice(2)
const cur = await current()

if (!args.length) {
  console.log(`現在の優先スキル: ${cur?.length ? cur.join(', ') : '(未設定＝全員が対象)'}`)
  process.exit(0)
}

const skills = args.includes('--clear') ? [] : args.map((s) => s.trim()).filter(Boolean)
const res = await fetch(`${URL}/rest/v1/app_config?on_conflict=key`, {
  method: 'POST',
  headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify([{ key: 'llm_filter_skills', value: skills }]),
})
if (!res.ok) {
  console.error(`保存に失敗: ${res.status} ${(await res.text()).slice(0, 200)}`)
  process.exit(1)
}

const after = await current()
console.log(`変更: ${cur?.length ? cur.join(', ') : '(未設定)'} → ${after?.length ? after.join(', ') : '(未設定＝全員が対象)'}`)
if (after?.length) {
  const hit = await countMatching(after)
  const all = await countMatching([])
  console.log(`対象人数: ${hit} / ${all}件（${(hit / all * 100).toFixed(1)}%）`)
}
