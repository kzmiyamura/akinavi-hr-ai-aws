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
import { TRANSCRIBE_RULES, TRANSCRIBE_RULES_TEXT, BODY_FIELDS_RULES, PROJECT_FIELDS_RULES } from './prompts.mjs'
import { callModel } from './caller.mjs'
import { verifyOutput } from './verify.mjs'

/** 経歴グリッド抽出のルーター本体。他モジュールからも利用可。
 *  kind='text' は docx/pdf 由来の疑似グリッド（1行=1セル）。プロンプトだけ変え、
 *  機械検証(verify.mjs)は行集合ベースなのでそのまま共用する */
export async function extractProjects(gridInput, { log = () => {}, kind = 'grid' } = {}) {
  const prompt = kind === 'text'
    ? TRANSCRIBE_RULES_TEXT + gridInput.rows.map(r => r[1].join(' ')).join('\n')
    : TRANSCRIBE_RULES + JSON.stringify(gridInput)
  const t0 = Date.now()

  const h = await callModel('haiku', prompt)
  const vh = verifyOutput(gridInput, h.data, 'primary')
  log(`haiku: proj=${h.data?.projects?.length} verify=${vh.escalate ? 'ESCALATE' : 'pass'} ${vh.reasons.join('|')}`)

  let final = { model: 'haiku', output: h.data, verify: vh, costUsd: h.costUsd ?? 0 }
  if (vh.escalate) {
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
