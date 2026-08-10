#!/usr/bin/env node
// llm_extract/run.mjs — Haiku→機械検証→Sonnet昇格 ルーター（単体実行CLI）
//
// 使い方:
//   node scripts/llm_extract/run.mjs <xlsxファイル>            # 経歴書からprojects+skillYears
//   node scripts/llm_extract/run.mjs --body <テキストファイル>  # メール本文から基本フィールド
//   node scripts/llm_extract/run.mjs --grid <グリッドJSON>     # 整形済みグリッドを直接
//   環境変数 ANTHROPIC_API_KEY があればAPI直、なければ claude -p (サブスク枠)
import fs from 'fs'
import { buildGridInput, buildTextGridInput, skillYearsFromProjects } from './lib.mjs'
import { TRANSCRIBE_RULES, TRANSCRIBE_RULES_TEXT, BODY_FIELDS_RULES, BODY_FIELDS_BATCH_RULES, PROJECT_FIELDS_RULES } from './prompts.mjs'
import { callModel } from './caller.mjs'
import { verifyOutput } from './verify.mjs'

/** Sonnet 昇格の一時停止スイッチ。1 で昇格せず haiku 結果を needs_review 付きで採用する */
const NO_ESCALATE = process.env.SHADOW_NO_ESCALATE === '1'

/** 経歴グリッド抽出のルーター本体。他モジュールからも利用可。
 *  kind='text' は docx/pdf 由来の疑似グリッド（1行=1セル）。プロンプトだけ変え、
 *  機械検証(verify.mjs)は行集合ベースなのでそのまま共用する */
export async function extractProjects(gridInput, { log = () => {}, kind = 'grid', onEscalate = null } = {}) {
  const prompt = kind === 'text'
    ? TRANSCRIBE_RULES_TEXT + gridInput.rows.map(r => r[1].join(' ')).join('\n')
    : TRANSCRIBE_RULES + JSON.stringify(gridInput)
  const t0 = Date.now()

  const h = await callModel('haiku', prompt)
  const vh = verifyOutput(gridInput, h.data, 'primary')
  log(`haiku: proj=${h.data?.projects?.length} verify=${vh.escalate ? 'ESCALATE' : 'pass'} ${vh.reasons.join('|')}`)

  let final = { model: 'haiku', output: h.data, verify: vh, costUsd: h.costUsd ?? 0 }
  if (vh.escalate && NO_ESCALATE) {
    // 昇格の一時停止（2026-08-10）。実測で昇格の約半分は needs_review のまま終わり、
    // 昇格1回あたり $0.27 の上乗せが回収できていなかった（escalation_report.mjs 参照）。
    // 下の「sonnet失敗→haiku結果を採用」と同じ着地点なので、抽出結果が失われることはない。
    log(`昇格停止中(SHADOW_NO_ESCALATE=1) → haiku結果を採用 proj=${h.data?.projects?.length} ${vh.reasons.join('|')}`)
    final = { model: 'haiku', output: h.data, verify: { ...vh, escalate: true }, costUsd: h.costUsd ?? 0 }
  } else if (vh.escalate) {
    // 昇格の開始を呼び出し側に通知する（UI に「AI校正中」を出すため）
    if (onEscalate) { try { await onEscalate() } catch { /* 通知失敗は処理を止めない */ } }
    try {
      const s = await callModel('sonnet', prompt)
      const vs = verifyOutput(gridInput, s.data, 'final')
      log(`sonnet: proj=${s.data?.projects?.length} verify=${vs.escalate ? 'NEEDS_REVIEW' : 'pass'} ${vs.reasons.join('|')}`)
      final = { model: 'sonnet', output: s.data, verify: vs, costUsd: (h.costUsd ?? 0) + (s.costUsd ?? 0) }
    } catch (e) {
      // 超大型経歴書では sonnet だけタイムアウトすることがある（AT・33案件PDF 実害）。
      // haiku の部分結果を捨てて全滅させるより、needs_review 付きで採用する方が価値がある
      log(`sonnet失敗(${String(e.message).slice(0, 40)}) → haiku結果を採用 proj=${h.data?.projects?.length}`)
      final = { model: 'haiku', output: h.data, verify: { ...vh, escalate: true }, costUsd: h.costUsd ?? 0 }
    }
  }

  return {
    model: final.model,
    status: final.verify.escalate ? 'needs_review' : 'ok',
    reasons: final.verify.reasons,
    projects: final.output?.projects ?? [],
    skillYears: skillYearsFromProjects(final.output?.projects),
    costUsd: final.costUsd,
    ms: Date.now() - t0,
  }
}

/** メール本文フィールド抽出（常にHaiku。単純タスクのため昇格なし） */
export async function extractBodyFields(bodyText) {
  const r = await callModel('haiku', BODY_FIELDS_RULES + bodyText)
  return {
    model: 'haiku',
    candidates: r.data?.candidates ?? [],
    mailType: r.data?.mailType ?? null,
    costUsd: r.costUsd ?? 0,
  }
}

/**
 * 複数人分のメール本文をまとめて1回のHaikuで抽出する（固定オーバーヘッドの分散）。
 * @param texts 本文の配列
 * @returns texts と同じ長さの配列。取り違えを防ぐため件数が合わなければ null を返し、
 *          呼び出し側は1件ずつの処理にフォールバックすること
 */
export async function extractBodyFieldsBatch(texts) {
  if (!texts.length) return { results: [], model: 'haiku', costUsd: 0 }
  const joined = texts.map((t, i) => `\n===== メール ${i + 1} =====\n${t}`).join('\n')
  const r = await callModel('haiku', BODY_FIELDS_BATCH_RULES + joined)
  const raw = r.data?.results
  if (!Array.isArray(raw) || raw.length !== texts.length) {
    return { results: null, model: 'haiku', costUsd: r.costUsd ?? 0, reason: `件数不一致(${raw?.length ?? 0}/${texts.length})` }
  }
  // no でも並び順でも対応付けできるようにする（no が欠けるモデル出力に備える）
  const byNo = new Map(raw.map((x, i) => [Number(x?.no ?? i + 1), x]))
  const results = texts.map((_, i) => {
    const x = byNo.get(i + 1) ?? raw[i]
    return { candidates: x?.candidates ?? [], mailType: x?.mailType ?? null }
  })
  return { results, model: 'haiku', costUsd: r.costUsd ?? 0 }
}

/** 案件テキストのフィールド抽出（常にHaiku。転記タスクのため昇格なし） */
export async function extractProjectFields(bodyText) {
  const r = await callModel('haiku', PROJECT_FIELDS_RULES + bodyText)
  return {
    model: 'haiku',
    projects: r.data?.projects ?? [],
    confidence: r.data?.confidence ?? 'low',
    costUsd: r.costUsd ?? 0,
  }
}

// ── CLI ──
const arg = process.argv[2]
const { pathToFileURL } = await import('url')
if (arg && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = m => console.error('[llm-extract]', m)
  if (arg === '--body') {
    const res = await extractBodyFields(fs.readFileSync(process.argv[3], 'utf8'))
    console.log(JSON.stringify(res, null, 2))
  } else {
    let gridInput, kind = 'grid'
    if (arg === '--grid') gridInput = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
    else if (/\.(docx|pdf)$/i.test(arg)) {
      const { extractResumeText } = await import('./textract.mjs')
      const ext = arg.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'
      gridInput = buildTextGridInput(await extractResumeText(arg, ext), ext)
      kind = 'text'
    } else gridInput = buildGridInput(arg)
    if (!gridInput) { console.error('経歴グリッドが見つかりません（日付セルなし）'); process.exit(1) }
    log(`sheet="${gridInput.sheet}" rows=${gridInput.rows.length}`)
    const res = await extractProjects(gridInput, { log, kind })
    console.log(JSON.stringify(res, null, 2))
  }
}
