#!/usr/bin/env node
// audit_skillyears_gap.mjs — スキル年数が取れていない人材の原因を切り分ける
//
// スキル年数はマッチング精度に直結する（「Javaを何年」が分からないと絞れない）。
// 取れない理由は大きく2つで、打ち手がまったく違う:
//   ・経歴書はあるのに抽出できていない → 抽出器の問題。直せる
//   ・そもそも経歴書が無い             → 入力が無い。取り込み経路の問題
// どちらがどれだけあるかを数えないと、直す場所を間違える。
//
// 読み取りのみ。転送量を抑えるため必要な項目だけ取る。
//
// 使い方: node scripts/audit_skillyears_gap.mjs [日数=3]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const DAYS = Number(process.argv[2] ?? 3)
const since = new Date(Date.now() - DAYS * 86400000).toISOString()

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const rows = await fetchAll(
  'candidates?select=id,name,resume_url,box_url,box_status,' +
  'sy:raw_profile->skillYears,checked:raw_profile->>_llm_checked_at,att:raw_profile->>attachmentCount' +
  `&data_env=eq.prod&merged_into=is.null&created_at=gte.${since}`)

const has = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length > 0
const ext = (u) => (String(u ?? '').toLowerCase().match(/\.(xlsx?|xlsm|docx?|pdf)(?:$|\?)/) ?? [])[1] ?? null

const g = { ok: [], extractFail: [], noResumeHasBox: [], noResumeNoBox: [], unsupported: [] }
for (const c of rows) {
  if (has(c.sy)) { g.ok.push(c); continue }
  if (c.resume_url) {
    const e = ext(c.resume_url)
    // .doc（旧バイナリ）は mammoth 非対応。PDFはtextract経由
    if (e === 'doc') g.unsupported.push(c)
    else g.extractFail.push(c)
  } else if (c.box_url) g.noResumeHasBox.push(c)
  else g.noResumeNoBox.push(c)
}

const pct = (n) => `${(n / rows.length * 100).toFixed(1)}%`
console.log(`直近${DAYS}日の prod 人材 ${rows.length}件\n`)
console.log(`スキル年数あり            ${String(g.ok.length).padStart(5)}件  ${pct(g.ok.length)}`)
console.log(`─ 以下、取れていないもの ─`)
console.log(`経歴書あり・抽出できず    ${String(g.extractFail.length).padStart(5)}件  ${pct(g.extractFail.length)}  ← 抽出器で直せる`)
console.log(`経歴書なし・Boxリンクあり ${String(g.noResumeHasBox.length).padStart(5)}件  ${pct(g.noResumeHasBox.length)}  ← 取込待ち`)
console.log(`経歴書なし・リンクもなし  ${String(g.noResumeNoBox.length).padStart(5)}件  ${pct(g.noResumeNoBox.length)}  ← 入力が無い`)
console.log(`未対応形式(.doc)          ${String(g.unsupported.length).padStart(5)}件  ${pct(g.unsupported.length)}`)

// 抽出できていないものは AI が走ったかどうかで打ち手が変わる
const failChecked = g.extractFail.filter((c) => c.checked).length
console.log(`\n「経歴書あり・抽出できず」の内訳:`)
console.log(`  AI校正済みでも取れず  ${failChecked}件  ← 抽出そのものが失敗`)
console.log(`  AI未処理（順番待ち）  ${g.extractFail.length - failChecked}件  ← 処理されれば取れる可能性`)
  // どの形式が支配的かで直す場所が変わる（xlsxならグリッド解析、pdf/docxならtextract）
  const byExt = new Map()
  for (const c of g.extractFail) {
    const e = ext(c.resume_url) ?? '(不明)'
    if (!byExt.has(e)) byExt.set(e, { total: 0, checked: 0 })
    const v = byExt.get(e); v.total++; if (c.checked) v.checked++
  }
  console.log('  拡張子別:')
  for (const [e, v] of [...byExt.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`    ${e.padEnd(8)} ${String(v.total).padStart(4)}件（AI校正済でも失敗 ${v.checked}件）`)
  }

// Box は取込ステータスで待ち状況が分かる
if (g.noResumeHasBox.length) {
  const byStatus = new Map()
  for (const c of g.noResumeHasBox) byStatus.set(c.box_status ?? '(なし)', (byStatus.get(c.box_status ?? '(なし)') ?? 0) + 1)
  console.log(`\n「Boxリンクあり」の取込ステータス:`)
  for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}件  ${k}`)
}

console.log(`\n「経歴書なし・リンクもなし」の例（先頭5件）:`)
for (const c of g.noResumeNoBox.slice(0, 5)) {
  console.log(`  ${(c.name ?? '').padEnd(16)} 添付数=${c.att ?? '—'}  ${c.checked ? 'AI校正済' : 'AI未処理'}`)
}
