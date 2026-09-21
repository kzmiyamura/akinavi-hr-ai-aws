#!/usr/bin/env node
/**
 * 取引先一覧の「人材ゼロの会社」が、本当に来ていないのか取り込めていないのかを分ける。
 *
 * agent_companies は入口だけあって出口が無い表で、人材は7日で消えるが会社は永久に残る。
 * 2026-09-21 時点で 235社中77社が「今いる人材ゼロ」。本番だけでは7日より前が見えない。
 *
 * candidates_archive_light には送信元が無い（id/data_env/prefecture/skills/
 * created_at/archived_at/name/subject のみ）ので使えない。
 * **ローカル控え（rp_from が2026-07-02まで遡る4,324人）**で判定する。
 *
 * ⚠ これをスパム探しに使わないこと。
 *   最初「スパム疑い」として出したら、中身は株式会社シーエーシー・コベルコソフトサービス・
 *   ぴあ・クラウドワークス・キーウェアといった**実在の大手ばかり**だった。
 *   「人材が来ていない」はスパムの証拠ではなく、**取り込みに失敗している証拠**。
 *   スパムの判定は「有名企業名を騙っている」等、別の根拠で行うこと
 *   （scripts/sql/list_junk_agent_companies.sql）。
 *
 * 判定:
 *   取り込めている   … 控えに、そのドメインから来た「人と分かる人材」が1人でもいる
 *   取り込めていない … 控えに1人もいない、または居ても全員「人ではない」
 *   判定不能         … 控えの期間より前にだけ来ていた（first_seen が控えの開始より古い）
 *
 * 会社一覧（ドメインと会社名）だけ本番から引く（235行・数KB）。人材は引かない。
 *
 *   node scripts/audit_agent_companies_activity.mjs <会社一覧JSON>
 *   （会社一覧は scripts/sql/agent_companies_list.sql の出力）
 */
import fs from 'fs'
import { loadRows } from './role_classifier/dataset.mjs'

const listPath = process.argv[2]
if (!listPath) {
  console.error('使い方: node scripts/audit_agent_companies_activity.mjs <会社一覧JSON>')
  process.exit(1)
}
const txt = fs.readFileSync(listPath, 'utf8')
const companies = JSON.parse(txt.slice(txt.indexOf('{'))).rows

/** 人と分かる人材か。inbound-email の NO_PERSON_FOUND と同じ考え方 */
const isRealPerson = (r) => {
  const nameOk = r.name && !['不明', '氏名未取得', ''].includes(String(r.name).trim())
  return !!(nameOk || r.rp_age != null || r.rp_gender || r.desired_rate ||
    r.rp_nearestStation || r.experience_years != null)
}

const rows = loadRows()
const byDomain = new Map()
let oldest = null
for (const r of rows) {
  const d = String(r.rp_from ?? '').split('@')[1]?.toLowerCase().trim()
  if (!d) continue
  if (!byDomain.has(d)) byDomain.set(d, { n: 0, real: 0, last: null })
  const e = byDomain.get(d)
  e.n++
  if (isRealPerson(r)) e.real++
  const t = r.created_at ?? null
  if (t && (!e.last || t > e.last)) e.last = t
  if (t && (!oldest || t < oldest)) oldest = t
}
console.log(`ローカル控え: ${rows.length}人 / ${byDomain.size}ドメイン（最古 ${String(oldest).slice(0, 10)}）\n`)

// ⚠ ラベルに注意。最初これを「スパム疑い」と名付けて出したが、**中身は実在の大手ばかり**だった
//   （株式会社シーエーシー・コベルコソフトサービス・ぴあ・クラウドワークス・キーウェア等）。
//   「人材が1人も来ていない」は**スパムの証拠ではなく、取り込みに失敗している証拠**。
//   実際 primary-gr.co.jp は9/19の調査で「233通送ってきて登録ゼロ」だった会社で、
//   入口を直したら 0人→15人 になった。消す対象ではなく、直す対象。
const buckets = { 取り込めている: [], 取り込めていない: [], 判定不能: [] }
for (const c of companies) {
  const d = String(c.domain ?? '').toLowerCase()
  const e = byDomain.get(d)
  if (e && e.real > 0) buckets.取り込めている.push({ ...c, ...e })
  else if (e && e.real === 0) buckets.取り込めていない.push({ ...c, ...e, why: `控えに${e.n}人いるが全員「人ではない」` })
  else if (oldest && c.first_seen_at && c.first_seen_at < oldest) buckets.判定不能.push({ ...c, why: '控えの開始より前にしか来ていない' })
  else buckets.取り込めていない.push({ ...c, n: 0, real: 0, why: '控えに1人も来ていない' })
}

console.log(`会社一覧: ${companies.length}社`)
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(14)} ${String(v.length).padStart(4)}社`)

console.log(`\n■ 取り込めていない（${buckets.取り込めていない.length}社）— **消す対象ではなく直す対象**`)
for (const c of buckets.取り込めていない.sort((a, b) => String(b.first_seen_at).localeCompare(String(a.first_seen_at)))) {
  console.log(`  ${String(c.first_seen_at ?? '').slice(0, 10)}  ${String(c.domain).padEnd(30)} ${String(c.company_name ?? '(名前なし)').slice(0, 26).padEnd(28)} ${c.why}`)
}

if (buckets.判定不能.length) {
  console.log(`\n■ 判定不能（${buckets.判定不能.length}社）— 控えの期間より前。消さないこと`)
  for (const c of buckets.判定不能.slice(0, 10)) {
    console.log(`  ${String(c.first_seen_at ?? '').slice(0, 10)}  ${String(c.domain).padEnd(30)} ${String(c.company_name ?? '').slice(0, 26)}`)
  }
}
