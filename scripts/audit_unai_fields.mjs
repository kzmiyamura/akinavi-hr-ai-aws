#!/usr/bin/env node
// audit_unai_fields.mjs — AI校正の対象外フィールドに埋もれた誤抽出を洗い出す
//
// 常駐AI（Haiku/Sonnet）が上書きするのは name/from_company/age/gender/experience_years/
// skillYears/projects が中心で、駅・都道府県・国籍・勤務形態・商流・役割・自己PR等は
// 対象外（FIELD_POLICY が fill、またはAIの抽出項目に無い）。
// そのため regex の誤抽出が誰にも直されず残り続ける。ここを定期的に機械監査する。
//
// 使い方: node scripts/audit_unai_fields.mjs [日数=7] [--samples=5]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split('\n')) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const DAYS = Number(process.argv.filter((a) => /^\d+$/.test(a))[0] ?? 7)
const N_SAMPLE = Number((process.argv.find((a) => a.startsWith('--samples=')) ?? '=5').split('=')[1]) || 5
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000).toISOString()
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATIONS = JSON.parse(readFileSync(join(ROOT, 'supabase/functions/inbound-email/station_data.json'), 'utf8'))

/** 「名鉄 犬山駅 ※愛知」等から駅名候補を作る（index.ts の stationNameCandidates と同じ考え方） */
function stationCandidates(s) {
  const base = String(s ?? '').replace(/[※（(].*$/s, '').replace(/徒歩\s*\d+\s*分|バス\s*\d+\s*分/g, '').trim()
  const out = []
  const push = (x) => {
    const k = x.replace(/駅$/, '').replace(/\s+/g, '').replace(/ヶ/g, 'ケ').trim()
    if (k && !out.includes(k)) out.push(k)
  }
  push(base)
  for (const tok of base.split(/[\s　、,/／]+/)) {
    if (!tok || /線$|鉄道$|電鉄$|^JR|^ＪＲ/.test(tok)) continue
    push(tok)
  }
  return out
}
const stationPrefs = (s) => {
  for (const c of stationCandidates(s)) if (STATIONS[c]) return [...new Set(STATIONS[c].map((e) => e.prefecture))]
  return null
}

const rows = []
for (let from = 0; ; from += 1000) {
  const q = `candidates?select=id,name,desired_rate,` +
    `station:raw_profile->>nearestStation,pref:raw_profile->>prefecture,nat:raw_profile->>nationality,` +
    `ws:raw_profile->>workStyleNote,emp:raw_profile->>employmentType,flow:raw_profile->>commercialFlow,` +
    `roles:raw_profile->roles` +
    `&data_env=eq.prod&merged_into=is.null&created_at=gte.${since}&order=created_at.desc&limit=1000&offset=${from}`
  const res = await fetch(`${URL}/rest/v1/${q}`, { headers: h })
  if (!res.ok) { console.error(`取得失敗 ${res.status}`); process.exit(1) }
  const page = await res.json()
  rows.push(...page)
  if (page.length < 1000) break
}

const COUNTRY = /日本|中国|韓国|台湾|ベトナム|インド|ネパール|フィリピン|ミャンマー|インドネシア|ブラジル|ペルー|アメリカ|イギリス|フランス|ドイツ|ロシア|モンゴル|スリランカ|バングラデシュ|パキスタン|タイ|マレーシア|シンガポール|ウズベキスタン|外国/

/** 検査項目: [見出し, 対象判定, 疑わしい判定, 表示値] */
const CHECKS = [
  ['都道府県が最寄駅と矛盾', (c) => c.station && c.pref,
    (c) => { const p = stationPrefs(c.station); return p && !p.includes(c.pref) },
    (c) => `${c.pref} ≠ ${c.station}（駅は${stationPrefs(c.station)?.join('/')}）`],
  ['最寄駅があるのに都道府県が空', (c) => c.station, (c) => !c.pref, (c) => c.station],
  ['国籍が国名でない', (c) => c.nat, (c) => !/籍$/.test(c.nat) && !COUNTRY.test(c.nat), (c) => c.nat],
  ['勤務形態がPR文（人物評語を含む）', (c) => c.ws,
    (c) => /コミュニケーション|人柄|性格|意欲|姿勢|貢献|対応力|力を持ち|印象/.test(c.ws), (c) => c.ws],
  ['勤務形態が長すぎる（40字超）', (c) => c.ws, (c) => c.ws.length > 40, (c) => c.ws.slice(0, 60)],
  ['最寄駅に不要語が混入', (c) => c.station,
    (c) => /[0-9０-９]{2,}|万円|歳|曜|時間|希望|以内|可能/.test(c.station), (c) => c.station],
  ['雇用形態に商流が混入', (c) => c.emp, (c) => /社先|次請|商流|\d社/.test(c.emp), (c) => c.emp],
  ['雇用形態が長すぎる（15字超）', (c) => c.emp, (c) => c.emp.length > 15, (c) => c.emp],
  ['単価に不自然な文字', (c) => c.desired_rate,
    (c) => !/万|円|\d/.test(c.desired_rate) || c.desired_rate.length > 30, (c) => c.desired_rate],
  ['役割が多すぎる（6個超＝拾いすぎ）', (c) => Array.isArray(c.roles) && c.roles.length,
    (c) => c.roles.length > 6, (c) => c.roles.join('/')],
]

console.log(`=== AI校正の対象外フィールド監査（prod・直近${DAYS}日・${rows.length}件）===\n`)
let total = 0
for (const [title, applies, suspicious, show] of CHECKS) {
  const target = rows.filter(applies)
  const hits = target.filter((c) => { try { return suspicious(c) } catch { return false } })
  total += hits.length
  const pct = target.length ? (hits.length / target.length * 100).toFixed(1) : '0.0'
  console.log(`${hits.length ? '⚠️ ' : '✅ '}${title}: ${hits.length}件 / 対象${target.length}件（${pct}%）`)
  for (const c of hits.slice(0, N_SAMPLE)) console.log(`     ${c.name}: ${show(c)}`)
}
console.log(`\n合計 ${total}件の疑わしい値を検出（AIは直さないため入口の修正が必要）`)
