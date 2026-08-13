#!/usr/bin/env node
// test_pdf_career_skillyears.mjs — PDF経歴書からの skillYears 復元効果を、デプロイ前に実データで測る
//
// 対象は「PDF経歴書があるのに skillYears が空」の prod 人材。
// extractSkillYearsFromCareerBlocks（叙述型の期間ブロック×スキル）を実際に当てて、
// 何件が救えるか・1人あたり何スキル取れるかを出す。
//
// PDF のダウンロードは egress を使う（1件あたり数百KB）。既定は30件サンプル。
// 全件見たいときだけ --all を付けること（116件で概ね30MB前後）。
//
// 使い方:
//   node scripts/test_pdf_career_skillyears.mjs            # 30件サンプル
//   node scripts/test_pdf_career_skillyears.mjs --limit 10 --verbose
//   node scripts/test_pdf_career_skillyears.mjs --all
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { extractPdfLines, ATTACH_TEXT_LIMIT } from './lib/pdf_text.mjs'
import { extractSkillYearsFromCareerBlocks, projParsePeriod } from './_extractors.gen.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
const LIMIT = args.includes('--all') ? 10000 : Number(arg('limit', 30))
const VERBOSE = args.includes('--verbose')

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const get = async (q) => {
  const r = await fetch(`${URL}/rest/v1/${q}`, { headers: H })
  if (!r.ok) throw new Error(`${q} -> ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const master = await get('skill_master?select=id,name,category,aliases&limit=5000')
console.log(`skill_master: ${master.length}件`)

const rows = await get(
  'candidates?select=id,name,resume_url,sy:raw_profile->skillYears' +
  '&data_env=eq.prod&merged_into=is.null&resume_url=ilike.*.pdf&order=created_at.desc')
const nkeys = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length
const targets = rows.filter((c) => nkeys(c.sy) === 0).slice(0, LIMIT)
console.log(`PDF人材 ${rows.length}件中、skillYears が空: ${rows.filter((c) => nkeys(c.sy) === 0).length}件 → ${targets.length}件を検証\n`)

const nowMonth = new Date().getFullYear() * 12 + (new Date().getMonth() + 1)
let recovered = 0, empty = 0, failed = 0, noHead = 0, lowYield = 0
const counts = []

for (const c of targets) {
  let text = ''
  try {
    const res = await fetch(c.resume_url, { headers: H })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { lines } = await extractPdfLines(new Uint8Array(await res.arrayBuffer()))
    text = lines.join('\n').slice(0, ATTACH_TEXT_LIMIT)  // 本番と同じ 8000字上限
  } catch (e) {
    failed++
    if (VERBOSE) console.log(`  [取得/解析失敗] ${c.name}: ${e.message}`)
    continue
  }
  // 落ちどころの内訳（期間見出しが無いのか、見出しはあるが結果が3件未満なのか）
  const RANGE_RE = /[〜～~]|から/
  let headCount = 0, durOnly = 0
  for (const l of text.split(/\r?\n/)) {
    const flat = l.replace(/\s/g, '')
    if (flat.length > 60) continue
    const { start, end, dur } = projParsePeriod(l, nowMonth)
    if (RANGE_RE.test(l) && start !== null && end !== null && end >= start && end - start <= 600) headCount++
    else if (dur !== null) durOnly++
  }

  // --heads: 見出しとして採用された行と解決した期間を出す（期間が膨らむ原因の特定用）
  if (args.includes('--heads')) {
    const ls = text.split(/\r?\n/)
    const DATE_RE = /(19|20)\d{2}\s*[年\/.\-]/
    console.log(`\n[heads] ${c.name}`)
    for (let i = 0; i < ls.length; i++) {
      if (!DATE_RE.test(ls[i]) || ls[i].replace(/\s/g, '').length > 60) continue
      for (let w = 1; w <= 3; w++) {
        const win = ls.slice(i, i + w).join(' ')
        if (!RANGE_RE.test(win)) continue
        const { start, end } = projParsePeriod(win, nowMonth)
        if (start === null || end === null || end < start || end - start > 600) continue
        console.log(`   w=${w} ${((end - start + 1) / 12).toFixed(1)}年  ${ls[i].slice(0, 70)}`)
        break
      }
    }
  }

  const sy = extractSkillYearsFromCareerBlocks(text, master, nowMonth)
  const n = Object.keys(sy).length
  if (n > 0) {
    recovered++
    counts.push(n)
    if (VERBOSE) {
      const top = Object.entries(sy).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `${k}:${(v / 12).toFixed(1)}年`).join(' ')
      console.log(`  ✅ ${String(c.name).padEnd(8)} ${String(n).padStart(3)}スキル  ${top}`)
    }
  } else {
    empty++
    if (headCount < 2) noHead++
    else lowYield++
    if (VERBOSE) console.log(`  ―  ${String(c.name).padEnd(8)} 0スキル  期間見出し=${headCount} 期間長のみ=${durOnly}`)
  }
}

const n = targets.length
const pct = (x) => n ? `${Math.round((x / n) * 100)}%` : '-'
counts.sort((a, b) => a - b)
console.log(`\n=== 結果 (${n}件) ===`)
console.log(`  復元できた      ${String(recovered).padStart(3)} (${pct(recovered)})`)
console.log(`  0件のまま       ${String(empty).padStart(3)} (${pct(empty)})`)
console.log(`    └ 期間見出しが2本未満 ${String(noHead).padStart(3)}  ← 期間長(N年Mヶ月)表記・単一職歴など`)
console.log(`    └ 見出しはあるが3件未満 ${String(lowYield).padStart(3)}  ← ブロック内にスキルが無い`)
console.log(`  取得/解析失敗   ${String(failed).padStart(3)} (${pct(failed)})`)
if (counts.length) {
  const med = counts[Math.floor(counts.length / 2)]
  console.log(`  復元時のスキル数: 中央値 ${med} / 最小 ${counts[0]} / 最大 ${counts[counts.length - 1]}`)
}
