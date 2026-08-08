// llm_extract/lib.mjs — 無損失整形(グリッド化)と skillYears 計算
// 別枠プロトタイプ: 既存 inbound-email パイプラインには依存しない（gen関数のみ再利用）
import XLSX from 'xlsx'
import { worksheetToGrid } from '../_extractors.gen.mjs'

export const NOW_YM = (() => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() + 1 })()

/** xlsx → {file, sheet, rows, merges} 無損失整形JSON（経歴シートは日付セル最多で選定） */
export function buildGridInput(xlsxPath) {
  const wb = XLSX.readFile(xlsxPath, { cellDates: true })
  let best = { n: -1 }
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn]
    const grid = worksheetToGrid(ws)
    const dates = grid.flat().filter(c => /^(19|20)\d{2}[\/年.\-]\d{1,2}/.test(String(c).trim())).length
    if (dates > best.n) best = { n: dates, sn, ws, grid }
  }
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
    const s = line.trim()
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
