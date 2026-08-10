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

/**
 * 「結果が使えない」条件。ここに当たったものだけ人を呼ぶ。
 *
 * 2026-08-10 の方針転換: 以前の判定は「Sonnet に昇格するか」を決めるもので、
 * 安く上げて上位モデルに直させる前提だったため引きが軽く、実測で 65% が該当した。
 * Sonnet を使わない運用では同じ基準がそのまま「人が見るべき」フラグになり、
 * 65% が要確認＝何の情報でもなくなる。
 *
 * そこで2つの概念を分けた:
 *   broken  … 案件が1件も取れない/日付が壊れている＝結果を使えない（実測2%）
 *   quality … 捕捉率・案件数差分などの程度問題。数値のまま保持し、二値フラグにしない
 *
 * tech_coverage(37%) や project_shortfall(16%) は「取りこぼしがある」であって
 * 「壊れている」ではないため、人を呼ぶ基準には使わない（呼ぶと麻痺する）。
 */
const BROKEN_GATES = /^(no_projects|bad_dates)/

/** Sonnet 昇格を復活させる場合の判定（SHADOW_USE_SONNET=1 のときだけ使う） */
export const shouldEscalate = (v) => v.reasons.length > 0

/**
 * 出力の機械検証。
 * @param gridInput {rows, merges}
 * @param output {projects:[{start,end,techs}], confidence}
 * @returns {{ broken:boolean, brokenReasons:string[], reasons:string[], quality:object }}
 *   broken        … 結果が使えない（needs_review にすべき）
 *   reasons       … 品質上の指摘も含む全件（記録・抽出器改善用）
 *   quality       … 程度を表す数値。フラグにせず、そのまま保存して後で分析する
 */
export function verifyOutput(gridInput, output) {
  const reasons = []
  const projects = output?.projects
  const emptyQuality = {
    coverage: null, gridToks: 0, est: 0, got: 0, shortfall: null,
    emptyTechsRatio: null, monthLabelAgree: null,
    selfConfidence: output?.confidence ?? null,
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    return { broken: true, brokenReasons: ['no_projects'], reasons: ['no_projects'], quality: emptyQuality }
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
  // 一致率は品質として保存するため、ブロック外の変数に出す（照合対象外の書式では null）
  const labels = monthLabels(gridInput.rows)
  let labelAgree = null
  if (labels.length >= Math.max(3, projects.length * 0.7)) {
    let agree = 0
    for (const p of projects) {
      const s = parseYM(p.start), e = parseYM(p.end)
      if (s == null || e == null) continue
      const months = Math.max(1, e - s + 1)
      if (labels.some(l => Math.abs(l - months) <= 1)) agree++
    }
    labelAgree = +(agree / projects.length).toFixed(2)
    if (labelAgree < THRESHOLDS.monthLabelAgree) reasons.push(`month_label(${labelAgree.toFixed(2)})`)
  }

  // 5. 日付形式・自己申告
  if (projects.some(p => parseYM(p.start) == null || parseYM(p.end) == null)) reasons.push('bad_dates')
  if (output.confidence === 'low') reasons.push('self_low_confidence')

  const brokenReasons = reasons.filter(r => BROKEN_GATES.test(r))
  return {
    broken: brokenReasons.length > 0,
    brokenReasons,
    reasons,
    quality: {
      coverage: gridToks.size ? +coverage.toFixed(2) : null,
      gridToks: gridToks.size,
      est,
      got: projects.length,
      shortfall: est - projects.length,
      emptyTechsRatio: +(empty / projects.length).toFixed(2),
      monthLabelAgree: labelAgree,
      selfConfidence: output.confidence ?? null,
    },
  }
}
