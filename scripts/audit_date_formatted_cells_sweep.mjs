#!/usr/bin/env node
/**
 * audit_date_formatted_cells_sweep.mjs
 *   「日付書式が付いた小さい数値」セルを持つ経歴書がどれくらいあるかを標本で測る。
 *
 * 背景（2026-08-12）: 本番は cellDates:true で読むため、期間列に日数を入れて
 * "00年9ヶ月" と表示するファイルでは数値が 1900〜1902年の日付に化ける。
 * cellToText がそれを日付として出力していたので期間列が壊れ、スキル表の抽出が
 * 丸ごと失敗していた（T.A: 52スキル → 0件）。修正済みだが、
 * **既に skillYears が入っている人にも影響していた可能性がある**（月数がおかしい等）。
 * 再解析し直す価値があるかを判断するために、影響ファイルの割合を測る。
 *
 * DBは変更しない（Storage から経歴書を読むだけ）。
 *
 * 使い方:
 *   node scripts/audit_date_formatted_cells_sweep.mjs            # 40件を標本調査
 *   node scripts/audit_date_formatted_cells_sweep.mjs --limit 100
 *   node scripts/audit_date_formatted_cells_sweep.mjs --with-skills  # skillYears 済みだけ
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import XLSX from 'xlsx'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/export\s+(\w+)=(.*)/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY が読めません'); process.exit(1) }

const args = process.argv.slice(2)
const limitAt = args.indexOf('--limit')
const LIMIT = Number(limitAt >= 0 ? args[limitAt + 1] : 0) || 40
const WITH_SKILLS = args.includes('--with-skills')
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` }

const q = 'candidates?select=id,name,resume_url,sy:raw_profile->skillYears' +
  '&data_env=eq.prod&merged_into=is.null&resume_url=like.*.xlsx' +
  `&order=created_at.desc&limit=${LIMIT * 3}`
const rows = await (await fetch(`${URL}/rest/v1/${q}`, { headers })).json()

const hasSy = (o) => Object.keys(o ?? {}).filter((k) => !k.startsWith('_')).length > 0
const targets = (WITH_SKILLS ? rows.filter((c) => hasSy(c.sy)) : rows).slice(0, LIMIT)

console.log(`標本: ${targets.length}件（prod・xlsx${WITH_SKILLS ? '・skillYears取得済み' : ''}）\n`)

let affected = 0, checked = 0, errors = 0
const details = []
for (const c of targets) {
  try {
    const res = await fetch(c.resume_url)
    if (!res.ok) { errors++; continue }
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array', cellDates: true })
    checked++
    let bad = 0
    const samples = []
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      if (!ws['!ref']) continue
      const range = XLSX.utils.decode_range(ws['!ref'])
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let col = range.s.c; col <= range.e.c; col++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c: col })]
          if (!cell || !(cell.v instanceof Date)) continue
          if (cell.v.getUTCFullYear() >= 1910) continue
          bad++
          if (samples.length < 3 && cell.w) samples.push(cell.w)
        }
      }
    }
    if (bad > 0) {
      affected++
      details.push({ name: c.name, id: c.id, bad, samples, sy: Object.keys(c.sy ?? {}).filter(k => !k.startsWith('_')).length })
    }
  } catch { errors++ }
}

console.log(`=== 日付書式が付いた数値セルを持つ経歴書 ===`)
console.log(`  該当    ${String(affected).padStart(3)}件 / 読めた ${checked}件（取得失敗 ${errors}件）`)
if (details.length > 0) {
  console.log('\n  氏名          化けセル数  今のskillYears  表示例')
  for (const d of details.sort((a, b) => b.bad - a.bad).slice(0, 20)) {
    console.log(`  ${String(d.name ?? '').padEnd(12)} ${String(d.bad).padStart(6)}個  ${String(d.sy).padStart(8)}件  ${d.samples.join(', ')}`)
  }
  console.log('\n  → 該当する人は再解析し直すと期間の読み取りが変わる可能性がある')
  console.log('     node scripts/bulk_replay_missing_skillyears.mjs 365 --run --id <id>')
}
