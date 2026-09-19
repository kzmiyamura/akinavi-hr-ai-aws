#!/usr/bin/env node
/**
 * 行末の空セルを落としても **AIの転記結果が変わらない** ことを実際に通して確かめる。
 *
 * 「無損失のはずだ」は理屈であって測定ではない。同じ経歴書を
 *   ① 従来どおり（行末の空セルを含む）
 *   ② 落としたもの
 * の2通りでHaikuに通し、案件数・期間・案件名を突き合わせる。
 *
 * ローカル控えのファイルを使う（本番からのダウンロードなし＝egress ゼロ）。
 * Haiku呼び出しが 1ファイルにつき2回発生する。既定は2ファイル＝4回。
 *
 *   node scripts/verify_grid_trim_parity.mjs [--files 2] [--days 2]
 */
import fs from 'fs'
import path from 'path'
import XLSX from 'xlsx'
import { buildGridInput, trimTrailingEmpty } from './llm_extract/lib.mjs'
import { TRANSCRIBE_RULES } from './llm_extract/prompts.mjs'
import { callModel } from './llm_extract/caller.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const ROOT = argOf('--dir', 'D:\\akinavi-archive\\mail')
const DAYS = Number(argOf('--days', '2'))
const FILES = Number(argOf('--files', '2'))

/** 変更前の挙動をその場で再現する（行末を落とさない版のグリッド） */
function buildGridInputUntrimmed(fp) {
  const g = buildGridInput(fp)
  if (!g) return null
  // 落とした行末を復元する。シート上の最大幅まで空セルで埋め直せば変更前と同じ形になる
  const wb = XLSX.readFile(fp, { cellDates: true })
  const ws = wb.Sheets[g.sheet]
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  const width = range.e.c + 1
  return { ...g, rows: g.rows.map(([i, cells]) => [i, Array.from({ length: width }, (_, j) => String(cells[j] ?? ''))]) }
}

const since = new Date(Date.now() - DAYS * 86400_000)
const dayDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => new Date(`${d.name}T23:59:59Z`) >= since)
  .map((d) => d.name).sort()

/** 中くらいの大きさのものを選ぶ（極端に大きいものだけで判断しない） */
const cands = []
outer: for (const day of dayDirs) {
  for (const m of fs.readdirSync(path.join(ROOT, day), { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const dir = path.join(ROOT, day, m.name)
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(xlsx?|xlsm)$/i.test(f)) continue
      const fp = path.join(dir, f)
      let g; try { g = buildGridInput(fp) } catch { continue }
      if (!g) continue
      const chars = JSON.stringify(g).length
      if (chars > 8000 && chars < 60000) cands.push({ fp, chars })
      if (cands.length >= FILES * 4) break outer
    }
  }
}
cands.sort((a, b) => a.chars - b.chars)
const picked = cands.slice(Math.floor(cands.length / 2), Math.floor(cands.length / 2) + FILES)
if (!picked.length) { console.log('対象ファイルが見つかりません'); process.exit(1) }

const key = (p) => `${p?.start ?? ''}|${p?.end ?? ''}|${String(p?.name ?? p?.title ?? '').replace(/\s/g, '').slice(0, 24)}`

let allSame = true
for (const { fp } of picked) {
  const trimmed = buildGridInput(fp)
  const full = buildGridInputUntrimmed(fp)
  const a = JSON.stringify(full), b = JSON.stringify(trimmed)
  console.log(`\n■ ${path.basename(fp)}`)
  console.log(`  入力: 従来 ${a.length.toLocaleString()}字 → 今回 ${b.length.toLocaleString()}字 (${((1 - b.length / a.length) * 100).toFixed(1)}%減)`)

  const [rFull, rTrim] = [
    await callModel('haiku', TRANSCRIBE_RULES + a),
    await callModel('haiku', TRANSCRIBE_RULES + b),
  ]
  const pf = rFull.data?.projects ?? [], pt = rTrim.data?.projects ?? []
  const kf = pf.map(key).sort(), kt = pt.map(key).sort()
  const same = JSON.stringify(kf) === JSON.stringify(kt)
  console.log(`  所要: 従来 ${(rFull.ms / 1000).toFixed(0)}秒 → 今回 ${(rTrim.ms / 1000).toFixed(0)}秒`)
  console.log(`  案件: 従来 ${pf.length}件 / 今回 ${pt.length}件  → ${same ? 'PASS 同一' : 'DIFF'}`)
  if (!same) {
    allSame = false
    console.log(`    従来のみ: ${kf.filter((k) => !kt.includes(k)).slice(0, 5).join(' , ') || '(なし)'}`)
    console.log(`    今回のみ: ${kt.filter((k) => !kf.includes(k)).slice(0, 5).join(' , ') || '(なし)'}`)
  }
}
console.log(`\n${allSame ? '✅ 全件で転記結果が一致' : '⚠ 差分あり。上の DIFF を確認すること'}`)
