#!/usr/bin/env node
// project_dedupe_skills.mjs — 案件の required_skills から表記ゆれの重複を落とし、
//                             意味を持たない role_summary を消す
//
// 背景（2026-08-12）: LLM補正が既存の required_skills に表記ゆれを追加していた。
//   Azure Functions があるのに AzureFunction / Microsoft 365 があるのに M365 /
//   システム側のヘルプデスク があるのに ヘルプデスク
// 必須スキルが増えると「何件中いくつ一致したか」の分母が膨らみ、同じ候補者でも
// マッチングスコアが下がる。追加自体は project_apply.mjs 側で止めたので、
// これは既に入ってしまった分の後片付け。
//
// _regex_backup への単純な巻き戻しはしない。EntraID や Microsoft Office のように
// 本文に実在する正しい追加まで消えるため、重複だけを狙って落とす。
//
// 判定（保守的に3つだけ。Java と JavaScript のような前方一致は対象外）:
//   ① 複数形違い: 末尾 s を除いて一致（azurefunction / azurefunctions）
//   ② 日本語の後方一致: 片方がもう片方の末尾（ヘルプデスク ⊂ システム側のヘルプデスク）
//   ③ skill_master の別名: 同じ正式名に紐づく別表記（M365 → Microsoft 365）
// 残すのは長いほう（情報量が多い側）。ただし③は skill_master の正式名を残す。
//
// 使い方:
//   node scripts/llm_extract/project_dedupe_skills.mjs         # ドライラン
//   node scripts/llm_extract/project_dedupe_skills.mjs --run   # 実行
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normTech } from './lib.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!m) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (!process.env[m[1]]) process.env[m[1]] = v
}
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }
const RUN = process.argv.includes('--run')
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const MEANINGLESS_ROLE = /^(メンバー|メンバ|要員|担当者?|増員|スタッフ|人員|作業者)$/
const HAS_JA = /[ぁ-んァ-ヶ一-龠]/
const singular = (k) => (k.length > 4 && k.endsWith('s') ? k.slice(0, -1) : k)

async function rest(q, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${q}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } })
  if (!res.ok) throw new Error(`${q} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return text.trim() ? JSON.parse(text) : null
}

// skill_master: 正規化キー → 正式名（別名の寄せ先を知るため）
const canonical = new Map()
for (let from = 0; ; from += 1000) {
  const rows = await rest(`skill_master?select=name,aliases&limit=1000&offset=${from}`)
  for (const s of rows ?? []) {
    canonical.set(normTech(s.name), s.name)
    for (const a of s.aliases ?? []) canonical.set(normTech(a), s.name)
  }
  if (!rows || rows.length < 1000) break
}
console.log(`skill_master 正規化キー ${canonical.size}件\n`)

/** required_skills から重複を落として返す（変更が無ければ null） */
function dedupe(skills) {
  const kept = []
  const dropped = []
  for (const raw of skills) {
    const k = normTech(raw)
    const canon = canonical.get(k)
    const dupOf = kept.find((keep) => {
      const kk = normTech(keep)
      if (singular(kk) === singular(k)) return true                                   // ①
      if (HAS_JA.test(raw) && HAS_JA.test(keep) && (kk.endsWith(k) || k.endsWith(kk))) return true // ②
      const keepCanon = canonical.get(kk)                                             // ③
      return Boolean(canon && keepCanon && canon === keepCanon)
    })
    if (!dupOf) { kept.push(raw); continue }
    // 正式名が判っていればそちらを残す。無ければ長いほうを残す
    const better = (canon && canon === raw) || (!canonical.get(normTech(dupOf)) && raw.length > dupOf.length)
    if (better) {
      dropped.push(dupOf)
      kept[kept.indexOf(dupOf)] = raw
    } else {
      dropped.push(raw)
    }
  }
  return dropped.length ? { kept, dropped } : null
}

const rows = await rest('projects?select=id,title,required_skills,role_summary&data_env=eq.prod&limit=1000')
let changed = 0
for (const p of rows ?? []) {
  const patch = {}
  const notes = []

  const res = dedupe(Array.isArray(p.required_skills) ? p.required_skills : [])
  if (res) {
    patch.required_skills = res.kept
    notes.push(`スキル重複除去: ${res.dropped.join(', ')} を削除（${p.required_skills.length}→${res.kept.length}件）`)
  }
  if (typeof p.role_summary === 'string' && MEANINGLESS_ROLE.test(p.role_summary.trim())) {
    patch.role_summary = null
    notes.push(`役割「${p.role_summary}」を削除（体制の人数表現で募集役割ではない）`)
  }
  if (!notes.length) continue

  changed++
  console.log(`${RUN ? '→' : '?'} ${String(p.title).slice(0, 34)}`)
  for (const n of notes) console.log(`    ${n}`)
  if (RUN) {
    await rest(`projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
  }
}
console.log(`\n${RUN ? '更新' : '更新予定'} ${changed}件`)
if (!RUN) console.log('ドライランです。実行するには --run を付けてください')
