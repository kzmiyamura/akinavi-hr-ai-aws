// llm_extract/verify.mjs — Haiku出力の機械検証（昇格ゲート）
// グリッドは手元にあるので、モデル出力の「読み落とし」は答え合わせなしで検出できる。
// regex資産は抽出器としては引退、ここで審判として再利用する。
import { normTech, parseYM } from './lib.mjs'

export const THRESHOLDS = {
  projectShortfall: 2,   // 推定案件数との許容差
  techCoverage: 0.63,    // グリッド内の技術らしきトークンの捕捉率下限
  emptyTechsRatio: 0.34, // techs空の案件の許容率
  monthLabelAgree: 0.5,  // 明示「Nヶ月」ラベルとの一致率下限
}

// 役割・見出し・一般語 — 技術トークン候補から除外
const STOP = new Set([
  'no', 'os', 'db', 'fw', 'mw', 'pg', 'se', 'pl', 'pm', 'pmo', 'tl', 'br', 'it',
  'careersheet', 'sheet', 'career', 'name', 'skill', 'web', 'file', 'mail', 'tel',
])

/** グリッド内の「技術らしき」英字トークン集合（正規化済み）
 *  - 日付が現れる行範囲±5行のみ対象（ドロップダウン用の隠しマスタ行等を除外）
 *  - 3桁以上の数字連続を含むトークンは機種名(HP9000/Express5800等)とみなし除外 */
export function gridTechTokens(rows) {
  const dateRows = rows.filter(([, cells]) => cells.some(c => /(19|20)\d{2}[\/年.\-]\d{1,2}/.test(String(c)))).map(([i]) => i)
  const lo = dateRows.length ? Math.min(...dateRows) - 5 : -Infinity
  const hi = dateRows.length ? Math.max(...dateRows) + 5 : Infinity
  const set = new Set()
  for (const [ri, cells] of rows) {
    if (ri < lo || ri > hi) continue
    for (const cell of cells) {
      for (const tok of String(cell).split(/[\n\r、，,\/／・;；]+/)) {
        const t = tok.trim().replace(/[（(][^）)]*[）)]/g, '').trim()
        // 英字始まり・2〜24文字。日本語トークンは誤爆源(工程/業種)が多いので対象外
        if (!/^[A-Za-zＡ-Ｚａ-ｚ][A-Za-z0-9＋+#.\s]{1,23}$/.test(t)) continue
        if (/\d{3}/.test(t)) continue // 機種名らしき数字連続
        const n = normTech(t)
        if (n.length < 2 || STOP.has(n)) continue
        set.add(n)
      }
    }
  }
  return set
}

/** グリッドから案件数を推定（範囲セル > 日付ペア/2 の順で信頼） */
export function estimateProjects(rows) {
  let rangeCells = 0, dateTokens = 0
  for (const [, cells] of rows) {
    for (const cell of cells) {
      const s = String(cell)
      dateTokens += (s.match(/(19|20)\d{2}[\/年.\-]\d{1,2}/g) || []).length
      if (/(19|20)\d{2}[\/年.\-]\d{1,2}[^\n]{0,12}[〜～~\-－]/.test(s)) rangeCells++
    }
  }
  return Math.max(rangeCells, Math.floor(dateTokens / 2))
}

/** グリッド内の明示期間ラベル（「Nヶ月」「N年Mヶ月」）を月数のリストで返す */
export function monthLabels(rows) {
  const out = []
  for (const [, cells] of rows) {
    for (const cell of cells) {
      const s = String(cell).trim()
      let m = s.match(/^[（(※]?\s*(\d{1,2})年(\d{1,2})[ヶカかヵ]月/)
      if (m) { out.push((+m[1]) * 12 + (+m[2])); continue }
      m = s.match(/^[（(※]?\s*(\d{1,3})[ヶカかヵ]月/)
      if (m) out.push(+m[1])
      m = s.match(/^[（(※]?\s*(\d{1,2})年\s*[）)]?$/)
      if (m) out.push((+m[1]) * 12)
    }
  }
  return out
}

/** ハードゲート（Sonnet後も適用: 引っかかれば needs_review） */
const HARD_GATES = /^(no_projects|bad_dates|project_shortfall|month_label|self_low_confidence)/

/**
 * 出力の機械検証。escalate=true なら上位モデルへ。
 * @param gridInput {rows, merges}
 * @param output {projects:[{start,end,techs}], confidence}
 * @param stage 'primary'(Haiku段: 全ゲート) | 'final'(Sonnet段: ハードゲートのみ)
 */
export function verifyOutput(gridInput, output, stage = 'primary') {
  const reasons = []
  const projects = output?.projects
  if (!Array.isArray(projects) || projects.length === 0) {
    return { escalate: true, reasons: ['no_projects'], stats: {} }
  }

  // 1. 案件数
  const est = estimateProjects(gridInput.rows)
  if (est - projects.length > THRESHOLDS.projectShortfall) {
    reasons.push(`project_shortfall(est=${est},got=${projects.length})`)
  }

  // 2. 技術トークン捕捉率
  const gridToks = gridTechTokens(gridInput.rows)
  const gotToks = new Set(projects.flatMap(p => (p.techs || []).map(normTech)))
  let hit = 0
  for (const t of gridToks) if (gotToks.has(t)) hit++
  const coverage = gridToks.size ? hit / gridToks.size : 1
  if (gridToks.size >= 5 && coverage < THRESHOLDS.techCoverage) {
    reasons.push(`tech_coverage(${coverage.toFixed(2)},grid=${gridToks.size})`)
  }

  // 3. techs空の案件率
  const empty = projects.filter(p => !(p.techs || []).length).length
  if (empty / projects.length > THRESHOLDS.emptyTechsRatio) {
    reasons.push(`empty_techs(${empty}/${projects.length})`)
  }

  // 4. 明示期間ラベルとの照合（ラベルが案件数の7割以上あるフォーマットのみ）
  const labels = monthLabels(gridInput.rows)
  if (labels.length >= Math.max(3, projects.length * 0.7)) {
    let agree = 0
    for (const p of projects) {
      const s = parseYM(p.start), e = parseYM(p.end)
      if (s == null || e == null) continue
      const months = Math.max(1, e - s + 1)
      if (labels.some(l => Math.abs(l - months) <= 1)) agree++
    }
    const rate = agree / projects.length
    if (rate < THRESHOLDS.monthLabelAgree) reasons.push(`month_label(${rate.toFixed(2)})`)
  }

  // 5. 日付形式・自己申告
  if (projects.some(p => parseYM(p.start) == null || parseYM(p.end) == null)) reasons.push('bad_dates')
  if (output.confidence === 'low') reasons.push('self_low_confidence')

  const active = stage === 'final' ? reasons.filter(r => HARD_GATES.test(r)) : reasons
  return { escalate: active.length > 0, reasons: active, allReasons: reasons,
    stats: { est, got: projects.length, coverage: +coverage.toFixed(2), gridToks: gridToks.size } }
}
