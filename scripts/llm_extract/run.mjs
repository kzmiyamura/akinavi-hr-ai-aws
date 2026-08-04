#!/usr/bin/env node
// llm_extract/run.mjs — Haiku→機械検証→Sonnet昇格 ルーター（単体実行CLI）
//
// 使い方:
//   node scripts/llm_extract/run.mjs <xlsxファイル>            # 経歴書からprojects+skillYears
//   node scripts/llm_extract/run.mjs --body <テキストファイル>  # メール本文から基本フィールド
//   node scripts/llm_extract/run.mjs --grid <グリッドJSON>     # 整形済みグリッドを直接
//   環境変数 ANTHROPIC_API_KEY があればAPI直、なければ claude -p (サブスク枠)
import fs from 'fs'
import { buildGridInput, skillYearsFromProjects } from './lib.mjs'
import { TRANSCRIBE_RULES, BODY_FIELDS_RULES } from './prompts.mjs'
import { callModel } from './caller.mjs'
import { verifyOutput } from './verify.mjs'

/** 経歴グリッド抽出のルーター本体。他モジュールからも利用可 */
export async function extractProjects(gridInput, { log = () => {} } = {}) {
  const prompt = TRANSCRIBE_RULES + JSON.stringify(gridInput)
  const t0 = Date.now()

  const h = await callModel('haiku', prompt)
  const vh = verifyOutput(gridInput, h.data, 'primary')
  log(`haiku: proj=${h.data?.projects?.length} verify=${vh.escalate ? 'ESCALATE' : 'pass'} ${vh.reasons.join('|')}`)

  let final = { model: 'haiku', output: h.data, verify: vh, costUsd: h.costUsd ?? 0 }
  if (vh.escalate) {
    const s = await callModel('sonnet', prompt)
    const vs = verifyOutput(gridInput, s.data, 'final')
    log(`sonnet: proj=${s.data?.projects?.length} verify=${vs.escalate ? 'NEEDS_REVIEW' : 'pass'} ${vs.reasons.join('|')}`)
    final = { model: 'sonnet', output: s.data, verify: vs, costUsd: (h.costUsd ?? 0) + (s.costUsd ?? 0) }
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
  return { model: 'haiku', candidates: r.data?.candidates ?? [], costUsd: r.costUsd ?? 0 }
}

// ── CLI ──
const arg = process.argv[2]
if (arg && import.meta.url === `file://${process.argv[1]}`) {
  const log = m => console.error('[llm-extract]', m)
  if (arg === '--body') {
    const res = await extractBodyFields(fs.readFileSync(process.argv[3], 'utf8'))
    console.log(JSON.stringify(res, null, 2))
  } else {
    const gridInput = arg === '--grid'
      ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
      : buildGridInput(arg)
    if (!gridInput) { console.error('経歴グリッドが見つかりません（日付セルなし）'); process.exit(1) }
    log(`sheet="${gridInput.sheet}" rows=${gridInput.rows.length}`)
    const res = await extractProjects(gridInput, { log })
    console.log(JSON.stringify(res, null, 2))
  }
}
