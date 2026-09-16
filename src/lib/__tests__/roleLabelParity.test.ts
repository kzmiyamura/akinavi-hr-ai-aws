/**
 * 役割ラベルの一覧が、5か所で一致していることを縛る。
 *
 * ラベルは複数箇所に分散していて、増やすときに1つ忘れると
 * role_affinity が 0.5（判定不能）を返して**静かに順位が狂う**。
 *   1. supabase/migrations/…role_axis（DB。正）
 *   2. supabase/functions/match-batch/index.ts の ROLE_AXIS
 *   3. supabase/functions/inbound-email/index.ts の ROLE_DEFS（抽出）
 *   4. scripts/llm_extract/project_apply.mjs の ROLE_LABELS（案件の requiredRole）
 *   5. scripts/llm_extract/prompts.mjs の ROLE_LABEL_LIST（AI校正・2026-09-16 追加）
 *
 * ここでは**テキストとして読み出して**突き合わせる（レプリカを作らない）。
 * 1と2は roleAffinityParity.test.ts が別途縛っているので、ここは 2〜5 を見る。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = (p: string) => resolve(__dirname, '../../../', p)

/** match-batch の ROLE_AXIS のキー（＝正とみなす集合） */
function axisLabels(): string[] {
  const src = readFileSync(root('supabase/functions/match-batch/index.ts'), 'utf8')
  const block = src.split('const ROLE_AXIS')[1]?.split('\n}')[0] ?? ''
  return [...block.matchAll(/'([^']+)':\s*\{\s*object:/g)].map(m => m[1])
}

/** inbound-email の ROLE_DEFS の label */
function extractorLabels(): string[] {
  const src = readFileSync(root('supabase/functions/inbound-email/index.ts'), 'utf8')
  const start = src.indexOf('const ROLE_DEFS')
  const block = src.slice(start, src.indexOf('\n  ]', start))
  return [...block.matchAll(/label:\s*'([^']+)'/g)].map(m => m[1])
}

/** project_apply.mjs の ROLE_LABELS */
function projectLabels(): string[] {
  const src = readFileSync(root('scripts/llm_extract/project_apply.mjs'), 'utf8')
  const block = src.split('export const ROLE_LABELS = new Set([')[1]?.split('])')[0] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1])
}

/** prompts.mjs の ROLE_LABEL_LIST */
function promptLabels(): string[] {
  const src = readFileSync(root('scripts/llm_extract/prompts.mjs'), 'utf8')
  const block = src.split('export const ROLE_LABEL_LIST = [')[1]?.split(']')[0] ?? ''
  return [...block.matchAll(/'([^']+)'/g)].map(m => m[1])
}

const AXIS = axisLabels()

describe('役割ラベルの一覧が場所ごとにズレていないこと', () => {
  it('定義表が読めている', () => {
    expect(AXIS.length).toBeGreaterThan(20)
    expect(AXIS).toContain('PMO')
    expect(AXIS).toContain('SRE')
  })

  it('抽出（inbound-email の ROLE_DEFS）が定義表に無いラベルを作らない', () => {
    for (const l of extractorLabels()) expect(AXIS, `ROLE_DEFS の ${l}`).toContain(l)
  })

  it('案件側（project_apply.mjs の ROLE_LABELS）が定義表と一致する', () => {
    expect([...projectLabels()].sort()).toEqual([...AXIS].sort())
  })

  it('AI校正（prompts.mjs の ROLE_LABEL_LIST）が定義表と一致する', () => {
    // 一覧外を返させるとラベルが role_axis に無く、role_affinity が 0.5 を返す
    expect([...promptLabels()].sort()).toEqual([...AXIS].sort())
  })
})
