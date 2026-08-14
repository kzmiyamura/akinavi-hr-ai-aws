// llm_extract/lib.mjs — 無損失整形(グリッド化)と skillYears 計算
// 別枠プロトタイプ: 既存 inbound-email パイプラインには依存しない（gen関数のみ再利用）
import XLSX from 'xlsx'
import { worksheetToGrid } from '../_extractors.gen.mjs'

export const NOW_YM = (() => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() + 1 })()

/** セル文字列が「西暦で始まる日付」か（従来の判定） */
const ANCHORED_DATE = /^(19|20)\d{2}[/年.\-]\d{1,2}/

/** 和暦の年月（`R7.9` `R7/6` `令和8年4月` `H28/4`）。
 *  実ファイル TK / MK が和暦だけで書かれており、西暦セル0件として捨てられていた
 *  （2026-08-14 実測）。元号1文字＋数字だけの `S3`（AWS S3）を拾わないよう、
 *  **月まで揃っている場合のみ**日付とみなす。 */
const WAREKI_DATE = /^(令和|平成|昭和|[RHSrhs])\s?(\d{1,2})\s*[年./\-]\s*(\d{1,2})/

/** セル内が改行されている場合に備えて行ごとに見る。
 *  実ファイル AN は `開始月⏎2026年4月` で、**西暦はあるのに先頭が見出し**だったため
 *  先頭一致に引っかからず0件になっていた（2026-08-14 実測）。 */
const cellLines = (c) => String(c).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

/** そのセルが日付を含むか（西暦・和暦の両方／セル内改行も見る） */
function cellHasDate(c) {
  return cellLines(c).some((line) => ANCHORED_DATE.test(line) || WAREKI_DATE.test(line))
}

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
  const anchored = grid.flat().filter(cellHasDate).length
  if (anchored > 0) return anchored
  let split = 0
  for (const row of grid) {
    for (let i = 0; i < row.length; i++) {
      if (!/^(19|20)\d{2}$/.test(String(row[i]).trim())) continue
      if (monthCellRightOf(row, i) !== -1) split++
    }
  }
  return split
}

/**
 * 記入フォーム型の「年」セルから見て、同じ行の右にある「月」セルの位置を返す（無ければ -1）。
 *
 * 実ファイル7件で数えた並び（2026-08-14・`probe_year_cell_layout.mjs`）:
 *   2026 |    |    | 年 |    | 9 |    | 月     ← 月は右5（最多・39/41 等）
 *   2019 | 年 | …  | 9                        ← 右2
 * セル結合で空セルが挟まり、「年」ラベルも独立セルになるため距離は 2〜6 に散る。
 * **想定で窓を決めて右3までにしていたため、主流の右5・右6 を取り逃していた。**
 *
 * 間に挟まってよいのは空セルと「年」ラベルだけにしてある。単純に右6まで数値を探すと
 * 「資格 | … | 認定 | … | 1999 | … | 1」のような無関係な数字を月と誤認する。
 */
function monthCellRightOf(row, yearIdx) {
  for (let j = yearIdx + 1; j < Math.min(row.length, yearIdx + 7); j++) {
    const s = String(row[j] ?? '').trim()
    if (s === '' || s === '年') continue                        // 空セル・年ラベルは飛ばす
    return /^\d{1,2}$/.test(s) && +s >= 1 && +s <= 12 ? j : -1  // 最初の実セルが月かどうか
  }
  return -1
}

/** xlsx → {file, sheet, rows, merges} 無損失整形JSON（経歴シートは日付セル最多で選定）。
 *  引数はパスでも Buffer でもよい（合成フィクスチャで回帰を回すため） */
export function buildGridInput(xlsxSrc) {
  const wb = Buffer.isBuffer(xlsxSrc) || xlsxSrc instanceof Uint8Array
    ? XLSX.read(xlsxSrc, { cellDates: true })
    : XLSX.readFile(xlsxSrc, { cellDates: true })
  let best = { n: -1 }
  for (const sn of wb.SheetNames) {
    // 記入例シートは**絶対に使わない**。「本人シートが読めなければ記入例で代替」という
    // フォールバックを一度入れて実害を出した（2026-08-14・YN で記入例の Zabbix/Ansible/
    // Terraform が本人スキルとして登録され、経験年数が 3年→9年 に化けた）。
    // 読めない経歴書は**読めないまま返す**のが正しい。他人の経歴を書くよりはるかにマシ
    if (EXAMPLE_SHEET.test(sn)) continue
    const ws = wb.Sheets[sn]
    const grid = worksheetToGrid(ws)
    const dates = countDateCells(grid)
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

/** 元号の開始年-1（令和1年=2019年 なので 2018 を足す） */
const ERA_BASE = { 令和: 2018, R: 2018, 平成: 1988, H: 1988, 昭和: 1925, S: 1925 }

export function parseYM(s) {
  if (!s) return null
  const t = String(s)
  if (/present|現在/.test(t)) return NOW_YM
  const m = t.match(/(\d{4})[/年.\-](\d{1,2})/)
  if (m) return (+m[1]) * 12 + (+m[2])
  // プロンプトでは西暦に直すよう指示しているが、和暦のまま返ることがある。
  // ここで拾わないと skillYears が丸ごと空になる（TK / MK は和暦だけの経歴書・2026-08-14）
  const w = t.match(/^\s*(令和|平成|昭和|[RHSrhs])\s?(\d{1,2})\s*[年./\-]\s*(\d{1,2})/)
  if (!w) return null
  const base = ERA_BASE[w[1].length === 1 ? w[1].toUpperCase() : w[1]]
  return base ? (base + +w[2]) * 12 + (+w[3]) : null
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
