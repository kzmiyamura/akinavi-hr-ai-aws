// llm_extract/lib.mjs — 無損失整形(グリッド化)と skillYears 計算
// 別枠プロトタイプ: 既存 inbound-email パイプラインには依存しない（gen関数のみ再利用）
import XLSX from 'xlsx'
import { worksheetToGrid } from '../_extractors.gen.mjs'

export const NOW_YM = (() => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() + 1 })()

/** セル文字列が「西暦で始まる日付」か（従来の判定） */
const ANCHORED_DATE = /^(19|20)\d{2}[/年.\-]\d{1,2}/

/** 記入例・サンプルのシート。日付が大量にあるので日付数だけで選ぶと本人シートに勝ち、
 *  **他人のサンプル記入を本人の経歴として転記する**（実例 YN の「スキルシート(NW・SV記入例)」は
 *  12案件・109ヶ月ぶんの日付を持つ。本人は経験3年）。本人のシートが無いときだけ使う */
const EXAMPLE_SHEET = /記入例|記載例|入力例|サンプル|見本|テンプレート|sample|example|template/i

/**
 * 日付セルを数える。年と月が別セルに分かれた記入フォーム型（`'2023' | '12'`）は
 * 従来の先頭一致だと0件になり、**経歴書が丸ごとAIに渡っていなかった**（2026-08-14 実測 YN）。
 * regex 経路はセル座標から期間を復元できるため、regex は読めるのに AI だけ読めない状態だった。
 *
 * 先頭一致が1件でもあればそちらを優先する（従来の選定を変えないため）。
 * 1件も無いときだけ、同じ行で「西暦のセル」の近傍に「1〜12のセル」がある組を数える。
 */
function countDateCells(grid) {
  const anchored = grid.flat().filter((c) => ANCHORED_DATE.test(String(c).trim())).length
  if (anchored > 0) return anchored
  let split = 0
  for (const row of grid) {
    for (let i = 0; i < row.length; i++) {
      if (!/^(19|20)\d{2}$/.test(String(row[i]).trim())) continue
      // 「年」の後ろに見出しや空セルを挟んで「月」が来る形まで拾う。
      // 窓を広げすぎると無関係な数値を月と誤認するので3セルまで
      for (let j = i + 1; j < Math.min(row.length, i + 4); j++) {
        const m = String(row[j]).trim()
        if (/^\d{1,2}$/.test(m) && +m >= 1 && +m <= 12) { split++; break }
      }
    }
  }
  return split
}

/** xlsx → {file, sheet, rows, merges} 無損失整形JSON（経歴シートは日付セル最多で選定）。
 *  引数はパスでも Buffer でもよい（合成フィクスチャで回帰を回すため） */
export function buildGridInput(xlsxSrc) {
  const wb = Buffer.isBuffer(xlsxSrc) || xlsxSrc instanceof Uint8Array
    ? XLSX.read(xlsxSrc, { cellDates: true })
    : XLSX.readFile(xlsxSrc, { cellDates: true })
  let best = { n: -1 }, bestExample = { n: -1 }
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn]
    const grid = worksheetToGrid(ws)
    const dates = countDateCells(grid)
    if (EXAMPLE_SHEET.test(sn)) { if (dates > bestExample.n) bestExample = { n: dates, sn, ws, grid } }
    else if (dates > best.n) best = { n: dates, sn, ws, grid }
  }
  // 全シートが記入例名のときだけ記入例に落ちる（本人シートが1枚も無いファイル）
  if (best.n < 1 && bestExample.n >= 1) best = bestExample
  if (best.n < 1) return null
  const merges = (best.ws['!merges'] || []).map(m => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }))
  const rows = []
  best.grid.forEach((r, i) => { if (r.some(c => String(c).trim())) rows.push([i, r.map(c => String(c))]) })
  return { sheet: best.sn, rows, merges, dateCells: best.n }
}

/** テキスト（docx/pdf抽出結果）→ buildGridInput と同形の疑似グリッド。
 *  1行=1セルの行集合にすることで verify.mjs の機械検証をそのまま流用する。
 *  日付が1つも無ければ経歴書とみなさず null（xlsx 側の「日付セルなし」と同じ扱い） */
export function buildTextGridInput(text, label = 'text') {
  const rows = []
  let dateCells = 0
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    // PDFのテキスト抽出は「2025 年 9 月」のように空白が混入し日付検出に失敗する
    // （HE実PDFで dateCells=0 → 抽出全滅の実害・2026-08-08 Issue #126）。空白を除去して正規化
    const s = line.trim().replace(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/g, '$1年$2月')
    if (!s) return
    if (/(19|20)\d{2}[\/年.\-]\d{1,2}/.test(s)) dateCells++
    rows.push([i, [s]])
  })
  if (dateCells < 1) return null
  return { sheet: label, rows, merges: [], dateCells }
}

export const normTech = s => String(s).toLowerCase().replace(/[\s　]/g, '')
  .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))

export function parseYM(s) {
  if (!s) return null
  if (/present|現在/.test(String(s))) return NOW_YM
  const m = String(s).match(/(\d{4})[\/年.\-](\d{1,2})/)
  return m ? (+m[1]) * 12 + (+m[2]) : null
}

function unionMonths(iv) {
  const s = iv.slice().sort((a, b) => a[0] - b[0])
  let tot = 0, cs = s[0][0], ce = s[0][1]
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i]
    if (a <= ce + 1) ce = Math.max(ce, b)
    else { tot += ce - cs + 1; cs = a; ce = b }
  }
  return tot + ce - cs + 1
}

/** projects[{start,end,techs[]}] → {表記そのままtech: 暦unionヶ月} */
export function skillYearsFromProjects(projects) {
  const iv = {}   // normKey -> intervals
  const disp = {} // normKey -> 初出の表記
  for (const p of projects || []) {
    const s = parseYM(p.start), e0 = parseYM(p.end)
    if (s == null || e0 == null) continue
    const e = Math.max(s, e0)
    for (const t of p.techs || []) {
      const k = normTech(t)
      if (!k || k.length < 2) continue
      ;(iv[k] = iv[k] || []).push([s, e])
      disp[k] = disp[k] || String(t).trim()
    }
  }
  const out = {}
  for (const [k, v] of Object.entries(iv)) out[disp[k]] = unionMonths(v)
  return out
}
