#!/usr/bin/env node
// probe_langcol.mjs — 「言語列の判定がセルの先頭行しか見ないため見つからない」仮説の検証
//
// extractSkillYearsFromSheetData の Method 1 は langColIdx>=0 が入口条件で、
// その判定は v = セル.split(/[\r\n]/)[0]（先頭行のみ）に対して行われる（_extractors.gen.mjs:1011）。
// 同じ関数内で全行連結の vFull は作られているが、月数列・No列にしか使われていない。
//
// ここでは各シートについて
//   ① 現行ロジック（先頭行のみ）で言語列が見つかるか
//   ② 全行連結（vFull）でも照合した場合に見つかるか
// を出す。②だけで見つかるシートが多ければ、これが取得ゼロの原因。
//
// 使い方: node scripts/probe_langcol.mjs [ファイル名...]
import { readdirSync } from 'fs'
import XLSX from 'xlsx'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { worksheetToGrid } from './_extractors.gen.mjs'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'testData/excel')
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => /\.(xlsx?|xls)$/i.test(f)).sort()

/** _extractors.gen.mjs:1023-1032 の言語列判定をそのまま写したもの */
function isLangHeader(vNorm) {
  const vAscii = vNorm.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  return (
    vNorm.includes('使用言語') || vNorm === '言語' || vNorm.includes('使用技術') ||
    vNorm.includes('技術スタック') || vNorm === '技術' || vNorm === '言語/技術' ||
    vNorm.includes('開発言語') || vNorm.includes('PG言語') ||
    (vNorm.includes('言語') && (vNorm.includes('FW') || vNorm.includes('ツール') || vNorm.includes('技術') ||
      vNorm.includes('DB') || vNorm.includes('OS') || vNorm.includes('環境') || vNorm.includes('その他'))) ||
    (vNorm.includes('言語') && (vAscii.includes('OS') || vAscii.includes('DB') || vAscii.includes('FW'))) ||
    vNorm.includes('利用技術') || /機種.*OS|OS.*言語|言語.*DB|言語.*OS/i.test(vNorm) ||
    /OS.*言語|言語.*DB/i.test(vAscii)
  )
}

const squash = (s) => String(s ?? '').replace(/[\s　]+/g, '')

console.log('ファイル        シート              先頭行のみ  全行連結  該当ヘッダー')
console.log('-'.repeat(96))
let onlyFull = 0
for (const file of files) {
  let wb
  try { wb = XLSX.readFile(join(dir, file), { cellDates: true }) } catch { continue }
  for (const sn of wb.SheetNames) {
    const data = worksheetToGrid(wb.Sheets[sn])
    if (!data?.length) continue
    let first = -1, full = -1, hit = ''
    for (let i = 0; i < Math.min(60, data.length); i++) {
      for (let j = 0; j < (data[i] ?? []).length; j++) {
        const raw = String(data[i][j] ?? '')
        const v = raw.split(/[\r\n]/)[0].trim()
        // 現行ロジックは 30 字超のセルを除外している（長文セルの誤爆対策）
        if (v.length <= 30 && first < 0 && isLangHeader(squash(v))) first = j
        const vFull = raw.replace(/[\r\n]+/g, '')
        if (vFull.length <= 30 && full < 0 && isLangHeader(squash(vFull))) {
          full = j
          hit = raw.replace(/[\r\n]+/g, '⏎').slice(0, 34)
        }
      }
      if (first >= 0) break
    }
    if (first < 0 && full < 0 && !hit) continue
    if (first < 0 && full >= 0) onlyFull++
    const mark = first < 0 && full >= 0 ? ' ★全行連結でのみ発見' : ''
    console.log(`${file.padEnd(15)} ${sn.slice(0, 18).padEnd(19)} ${String(first).padStart(9)}  ${String(full).padStart(8)}  ${hit}${mark}`)
  }
}
console.log(`\n全行連結にすると新たに言語列が見つかるシート: ${onlyFull}件`)
