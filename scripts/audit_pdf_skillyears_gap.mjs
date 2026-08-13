#!/usr/bin/env node
// audit_pdf_skillyears_gap.mjs — PDF経歴書で skillYears が空の人材を、原因別に数える
//
// skillYears の取得率は PDF 38% / Excel 95%（2026-08-13 時点）で、PDF だけ極端に低い。
// ただし「PDFだから取れない」では打ち手が決まらない。実際の詰まりどころは2つあり、
// 直す場所がまったく違う:
//   ① テキスト層が無い（スキャンPDF）→ 抽出器を直しても永久に取れない。OCR の話になる
//   ② テキストは取れているが年数を読めていない → 抽出器の問題。直せる
//
// ②が主なら投資対効果が高い。①が主なら別の手（OCR / 送り主への依頼）を考えることになる。
// raw_profile.excelParseNotes に「テキスト層なし」を記録してあるので、それで切り分ける。
//
// 読み取りのみ。raw_profile は丸ごと取らず必要な JSON パスだけ取る（1件35KB対策）。
//
// 使い方: node scripts/audit_pdf_skillyears_gap.mjs [--list]
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const LIST = process.argv.includes('--list')

async function fetchAll(pathq) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL}/rest/v1/${pathq}&limit=1000&offset=${from}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
    if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const rows = await res.json()
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

// text は本文の長さだけ見たいが、丸ごと取ると転送量が爆発する。
// PostgREST では JSON の長さを取れないので、テキスト有無の判断は notes と skills 件数で行う。
const rows = await fetchAll(
  'candidates?select=id,name,resume_url,' +
  'sy:raw_profile->skillYears,notes:raw_profile->excelParseNotes,' +
  'skills:raw_profile->skills,exp:raw_profile->>experienceYears' +
  '&data_env=eq.prod&merged_into=is.null&resume_url=ilike.*.pdf')

const nkeys = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length
const noteText = (c) => (Array.isArray(c.notes) ? c.notes.join(' / ') : '')

const g = { ok: [], scanned: [], parseNote: [], textButNoYears: [], noNote: [] }
for (const c of rows) {
  if (nkeys(c.sy) > 0) { g.ok.push(c); continue }
  const nt = noteText(c)
  if (/テキスト層なし/.test(nt)) g.scanned.push(c)
  else if (nt) g.parseNote.push(c)
  // skills が取れている＝テキストは読めている。なのに年数だけ空、が①と②を分ける決め手
  else if (Array.isArray(c.skills) && c.skills.length > 0) g.textButNoYears.push(c)
  else g.noNote.push(c)
}

const pct = (n) => rows.length ? ` (${Math.round((n / rows.length) * 100)}%)` : ''
console.log(`\nPDF経歴書の人材: ${rows.length}件（prod・統合済み除く）\n`)
console.log(`  skillYears あり            ${String(g.ok.length).padStart(4)}${pct(g.ok.length)}`)
console.log(`  ── 以下が空 ──`)
console.log(`  スキャンPDF(テキスト層なし) ${String(g.scanned.length).padStart(4)}${pct(g.scanned.length)}  ← 抽出器では直らない`)
console.log(`  スキルは取れている(年数だけ空)${String(g.textButNoYears.length).padStart(4)}${pct(g.textButNoYears.length)}  ← 抽出器の伸びしろ`)
console.log(`  その他のパース注記あり      ${String(g.parseNote.length).padStart(4)}${pct(g.parseNote.length)}`)
console.log(`  注記なし・スキルも空        ${String(g.noNote.length).padStart(4)}${pct(g.noNote.length)}  ← 取り込み時期が古く計測不能を含む`)

if (LIST) {
  for (const [label, arr] of [['スキルあり年数なし', g.textButNoYears], ['注記なし・スキルも空', g.noNote], ['その他注記', g.parseNote]]) {
    if (!arr.length) continue
    console.log(`\n--- ${label} (${arr.length}件) ---`)
    for (const c of arr.slice(0, 40)) {
      console.log(`  ${c.id}  ${String(c.name ?? '').slice(0, 12).padEnd(12)} skills=${(c.skills ?? []).length} exp=${c.exp ?? '-'} ${noteText(c).slice(0, 60)}`)
    }
    if (arr.length > 40) console.log(`  ... 他 ${arr.length - 40}件`)
  }
}
