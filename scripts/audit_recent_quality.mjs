#!/usr/bin/env node
// audit_recent_quality.mjs — 直近登録された人材の読み取り品質を目視できる形で出す
//
// 個別の項目ごとにテストはあるが、「実際に登録された1人分がまとまってどう見えるか」は
// 別に見ないと気づけない異常がある（氏名に生年月日・勤務形態に件名 等はこれで見つかった）。
//
// 読み取りのみ。Claude は呼ばない。
//
// 使い方: node scripts/audit_recent_quality.mjs [件数=10]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const N = Number(process.argv[2] ?? 10)

const res = await fetch(
  `${URL}/rest/v1/candidates?select=id,name,from_company,desired_rate,experience_years,skills,raw_profile,created_at` +
  `&data_env=eq.prod&merged_into=is.null&order=created_at.desc&limit=${N}`,
  { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
const rows = await res.json()

/** 明らかにおかしい値を指摘する（人名でない・長すぎる・別項目の混入など） */
function flags(c) {
  const rp = c.raw_profile ?? {}
  const f = []
  const name = String(c.name ?? '')
  if (/[0-9０-９]/.test(name)) f.push('氏名に数字')
  if (/(昭和|平成|令和)/.test(name)) f.push('氏名が生年月日')
  if (/(オープン系|汎用系|制御系|開発系|運用系)$/.test(name)) f.push('氏名がスキル分類')
  if (/^(不明|要員|人材|エンジニア)$/.test(name)) f.push('氏名が未取得')
  const ws = String(rp.workStyleNote ?? '')
  if (ws.length > 30) f.push(`勤務形態が長文(${ws.length}字)`)
  if (/\d+\s*名|ご紹介|ご案内/.test(ws)) f.push('勤務形態に営業文言')
  const st = String(rp.nearestStation ?? '')
  // 路線名は有用な情報なので指摘しない（「都営新宿線瑞江駅」は正常）。
  // FIELD_POLICY が問題視していたのは「月～都営大江戸線　西新宿五丁目駅」のような
  // 曜日・徒歩分数の混入で、そちらだけを拾う
  if (st && !/駅|停|港$/.test(st) && st.length > 12) f.push(`駅名が長い(${st.length}字)`)
  if (/[月火水木金土日]\s*[～~]|徒歩\s*\d/.test(st)) f.push('駅名に曜日/徒歩')
  const rate = String(c.desired_rate ?? '')
  if (rate.length > 20) f.push(`単価が長文(${rate.length}字)`)
  const co = String(c.from_company ?? '')
  if (co && (co.length > 30 || /経歴書|添付|Box/.test(co))) f.push('会社名が不審')
  const ey = c.experience_years
  if (ey != null && (ey < 0 || ey > 60)) f.push(`経験年数が異常(${ey})`)
  return f
}

const skillCount = (s) => (Array.isArray(s) ? s.length : 0)
const syCount = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length
const cut = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }

let bad = 0
console.log(`直近 ${rows.length}件の読み取り品質（新しい順）\n`)
for (const c of rows) {
  const rp = c.raw_profile ?? {}
  const f = flags(c)
  if (f.length) bad++
  const ai = rp._llm_checked_at ? 'AI校正済' : 'regexのみ'
  console.log(`■ ${c.name ?? '(なし)'}   [${ai}]  ${c.created_at?.slice(0, 16)}`)
  console.log(`   会社: ${cut(c.from_company, 28) || '—'}   単価: ${cut(c.desired_rate, 20) || '—'}`)
  console.log(`   雇用: ${rp.employmentType ?? '—'} / 商流: ${rp.commercialFlow ?? '—'}   駅: ${cut(rp.nearestStation, 20) || '—'}（${rp.prefecture ?? '—'}）`)
  console.log(`   経験: ${c.experience_years ?? '—'}年   スキル: ${skillCount(c.skills)}件   スキル年数: ${syCount(rp.skillYears)}件   年齢/性別: ${rp.age ?? '—'}/${rp.gender ?? '—'}`)
  if (rp.workStyleNote) console.log(`   勤務形態: ${cut(rp.workStyleNote, 46)}`)
  if (rp._experience_source) {
    const s = rp._experience_source
    console.log(`   経験年数の採用元: ${s.source}（案件表=${s.fromProjects ?? '—'} / 申告=${s.claimed ?? '—'}）`)
  }
  if (f.length) console.log(`   ⚠ ${f.join(' / ')}`)
  console.log()
}
console.log(`指摘あり: ${bad} / ${rows.length}件`)
