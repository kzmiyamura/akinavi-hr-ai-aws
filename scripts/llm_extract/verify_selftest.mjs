#!/usr/bin/env node
// verify_selftest.mjs — verifyOutput の単体テスト
//
// 2026-08-10 の方針転換（Sonnet 昇格をやめ、Haiku 単独運用）に伴い、
// 判定の意味が「上位モデルに上げるか」→「人が見るべきか」に変わった。
// 要となる性質は「取りこぼし（程度問題）で人を呼ばない」こと。
//
// 実行: node scripts/llm_extract/verify_selftest.mjs
import { verifyOutput, shouldEscalate } from './verify.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (JSON.stringify(got) === JSON.stringify(expect)) pass++
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)}\n    exp=${JSON.stringify(expect)}`) }
}

/** 日付セルと技術セルを持つグリッド。
 *  捕捉率の判定はグリッド内の技術トークンが5個以上のときだけ働くため（verify.mjs:102）、
 *  実データに近い数の技術を置く */
const grid = (rows) => ({ rows: rows.map((cells, i) => [i, cells]), merges: [] })
const GRID = grid([
  ['期間', '言語'],
  ['2020/01〜2021/12', 'Java', 'Oracle', 'Linux'],
  ['2022/01〜2023/12', 'Python', 'PostgreSQL', 'Docker'],
  ['2024/01〜2024/12', 'AWS', 'Terraform', 'Kubernetes'],
])

// ── 壊れている＝人を呼ぶ ──
t('案件ゼロは broken',
  verifyOutput(GRID, { projects: [], confidence: 'high' }).broken, true)
t('案件ゼロの理由',
  verifyOutput(GRID, { projects: [], confidence: 'high' }).brokenReasons, ['no_projects'])
t('projectsが配列でなければ broken',
  verifyOutput(GRID, { projects: null }).broken, true)

const badDate = { projects: [{ start: 'いつか', end: 'ずっと', techs: ['Java'] }], confidence: 'high' }
t('日付が読めなければ broken', verifyOutput(GRID, badDate).broken, true)
t('日付が読めない理由に bad_dates',
  verifyOutput(GRID, badDate).brokenReasons.some((r) => r.startsWith('bad_dates')), true)

// ── 取りこぼしは「程度問題」なので人を呼ばない（今回の方針転換の核心）──
const partial = {
  projects: [{ start: '2020/01', end: '2021/12', techs: ['Java'] }],   // Python/AWS を取りこぼし
  confidence: 'high',
}
const vPartial = verifyOutput(GRID, partial)
t('取りこぼしがあっても broken にしない', vPartial.broken, false)
t('取りこぼしは reasons には残す（記録用）', vPartial.reasons.length > 0, true)

const lowConf = {
  projects: [{ start: '2020/01', end: '2021/12', techs: ['Java', 'Python', 'AWS'] }],
  confidence: 'low',
}
t('モデルの自己申告 low だけでは人を呼ばない', verifyOutput(GRID, lowConf).broken, false)
t('自己申告は reasons に残す',
  verifyOutput(GRID, lowConf).reasons.includes('self_low_confidence'), true)

// ── 品質は数値として保持される ──
const q = vPartial.quality
t('捕捉率が数値で入る', typeof q.coverage === 'number' || q.coverage === null, true)
t('推定案件数が入る', typeof q.est === 'number', true)
t('抽出案件数が入る', q.got, 1)
t('差分が入る', q.shortfall, q.est - 1)
t('自己申告が入る', q.selfConfidence, 'high')

// ── 正常系 ──
const good = {
  projects: [
    { start: '2020/01', end: '2021/12', techs: ['Java', 'Oracle', 'Linux'] },
    { start: '2022/01', end: '2023/12', techs: ['Python', 'PostgreSQL', 'Docker'] },
    { start: '2024/01', end: '2024/12', techs: ['AWS', 'Terraform', 'Kubernetes'] },
  ],
  confidence: 'high',
}
t('全部取れていれば broken でない', verifyOutput(GRID, good).broken, false)
t('全部取れていれば reasons も空', verifyOutput(GRID, good).reasons, [])

// ── Sonnet を復活させる場合の判定は従来どおり「指摘が1つでもあれば」──
t('shouldEscalate: 指摘があれば true', shouldEscalate(vPartial), true)
t('shouldEscalate: 指摘が無ければ false', shouldEscalate(verifyOutput(GRID, good)), false)

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
