#!/usr/bin/env node
/**
 * backfill_project_matching_fields.mjs — 既存案件に work_prefecture / required_experience_years を埋める
 *
 * 2026-08-12 に追加したこの2カラムは inbound-email の抽出時に埋まるが、それ以前に登録済みの
 * 案件は空のまま。手動登録した既存案件をマッチングで正しく採点させるために遡って埋める。
 *
 * 勤務地→都道府県の解決は Edge Function（index.ts の resolveProjectPrefecture）と同じ方針:
 *   ①文字列に都道府県が含まれる → ②勤務地を駅名候補に分解し station_data.json に照合 → ③本文から拾う
 * ※ index.ts とは自動同期されない写しなので、恒常的な処理ではなく遡り用途に限る
 *
 * 使い方:
 *   node scripts/backfill_project_matching_fields.mjs         # ドライラン
 *   node scripts/backfill_project_matching_fields.mjs --run   # 実行（projects を UPDATE）
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATION_MASTER_MAP = JSON.parse(
  readFileSync(new URL('../supabase/functions/inbound-email/station_data.json', import.meta.url), 'utf8'))

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }
const RUN = process.argv.includes('--run')
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

const PREFECTURES = [
  '北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県',
  '埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県',
  '岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県',
  '鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県',
  '佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県',
]
const KANTO_PREFS = ['東京都', '神奈川県', '埼玉県', '千葉県']

function splitLocationTokens(workLocation) {
  return workLocation
    .replace(/(最寄り(?:駅)?は?|または|もしくは|周辺|近郊|徒歩\s*\d+\s*分|各線|駅から)/g, ' ')
    .split(/[（）()\[\]「」、,，/／・|｜\s]+/)
    .map((s) => s.replace(/駅$/, '').trim())
    .filter((s) => s.length >= 2 && s.length <= 20)
}

function lookupStationPrefecture(station) {
  if (!station) return null
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim().replace(/ヶ/g, 'ケ')
  if (!cleaned) return null
  const entries = STATION_MASTER_MAP[cleaned]
  if (!entries || entries.length === 0) return null
  const distinct = [...new Set(entries.map((e) => e.prefecture))]
  if (distinct.length === 1) return distinct[0]
  const kanto = distinct.filter((p) => KANTO_PREFS.includes(p))
  return kanto.length === 1 ? kanto[0] : null
}

function resolveProjectPrefecture(workLocation, fallbackText) {
  const loc = (workLocation ?? '').trim()
  if (loc) {
    const direct = PREFECTURES.find((p) => loc.includes(p))
    if (direct) return direct
    for (const token of splitLocationTokens(loc)) {
      const pref = lookupStationPrefecture(token)
      if (pref) return pref
    }
  }
  let firstIdx = Infinity, firstPref = null
  for (const p of PREFECTURES) {
    const idx = (fallbackText ?? '').indexOf(p)
    if (idx !== -1 && idx < firstIdx) { firstIdx = idx; firstPref = p }
  }
  return firstPref
}

function extractRequiredExperienceYears(text) {
  if (!text) return null
  const t = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
  const SUFFIX = '(?:以上|程度|前後|超)'
  const patterns = [
    new RegExp(`(?:実務|開発|業務|運用|設計|IT)?経験[^\\n。]{0,14}?(?<![\\d])(\\d{1,2})\\s*年${SUFFIX}`),
    new RegExp(`(?<![\\d])(\\d{1,2})\\s*年${SUFFIX}[^\\n。]{0,14}?(?:実務|開発|業務|運用|設計|IT)?経験`),
    /経験年数[^\n]{0,6}[：:]\s*(?<![\d])(\d{1,2})\s*年/,
  ]
  // 候補者側の experience_years は IT実務経験年数。社会人歴・在籍年数は突き合わせられないので拾わない
  const NOT_IT_EXPERIENCE = /(社会人|勤務|就業|在籍|社歴|同一企業)/
  for (const re of patterns) {
    for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
      const at = m.index ?? 0
      const ctx = t.slice(Math.max(0, at - 12), at + m[0].length + 12)
      if (NOT_IT_EXPERIENCE.test(ctx)) continue
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= 1 && n <= 40) return n
    }
  }
  return null
}

// description には【スキル】欄が入らないため、元メール全文（raw_data.text）も見る。
// ただし1通に複数案件が入っていた場合（batchSize>1）は他案件の記述を巻き込むので使わない
const res = await fetch(
  `${URL_}/rest/v1/projects?select=id,title,description,work_location,work_prefecture,` +
  `required_experience_years,srctext:raw_data->>text,batchsize:raw_data->batchSize` +
  `&data_env=eq.prod&limit=1000`,
  { headers })
if (!res.ok) { console.error(`${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1) }
const rows = await res.json()
console.log(`案件 ${rows.length}件\n`)

let updated = 0, skipped = 0
for (const p of rows) {
  const singleProjectMail = Number(p.batchsize ?? 1) <= 1
  const text = [p.title ?? '', p.description ?? '', singleProjectMail ? (p.srctext ?? '') : ''].join('\n')
  const pref = p.work_prefecture ?? resolveProjectPrefecture(p.work_location, text)
  const years = p.required_experience_years ?? extractRequiredExperienceYears(text)
  const needs = (pref !== p.work_prefecture) || (years !== p.required_experience_years)
  const tag = String(p.title ?? '').slice(0, 32).padEnd(34)
  if (!needs) { skipped++; console.log(`  -  ${tag} 変更なし`); continue }
  console.log(`  ${RUN ? '→' : '?'}  ${tag} 県=${pref ?? '解決できず'} 要求年数=${years ?? '—'}  ← "${String(p.work_location ?? '').slice(0, 30)}"`)
  if (!RUN) { updated++; continue }
  const patch = await fetch(`${URL_}/rest/v1/projects?id=eq.${p.id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ work_prefecture: pref, required_experience_years: years }),
  })
  if (!patch.ok) { console.log(`     FAIL ${patch.status} ${(await patch.text()).slice(0, 120)}`); continue }
  updated++
}
console.log(`\n${RUN ? '更新' : '更新予定'} ${updated}件 / 変更なし ${skipped}件`)
if (!RUN) console.log('ドライランです。実行するには --run を付けてください')
