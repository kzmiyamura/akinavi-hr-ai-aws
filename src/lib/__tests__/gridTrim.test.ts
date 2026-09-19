/**
 * 経歴書グリッドの行末空セル落とし（scripts/llm_extract/lib.mjs の trimTrailingEmpty）。
 *
 * 実測（2026-09-19・ローカル控えの xlsx 247件・`node scripts/measure_grid_compaction.mjs`）で、
 * AIに送っているセルの 92.3% が空文字だった。行末の空セルは後ろに値が無いので
 * 列位置の情報を持たず、落としても転記は変わらない（実測 26.0%減）。
 *
 * ここで守りたいのは **間の空セルは絶対に落とさない** こと。落とすと桁がずれ、
 * 「開始月」と「案件名」が別の列に化けて経歴が壊れる。
 *
 * レプリカは作らず、**実際に動く lib.mjs から関数を切り出して**検証する
 * （nameLabelGate.test.ts と同じ流儀。型定義の無い .mjs を import すると tsc -b が通らない）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../scripts/llm_extract/lib.mjs')

function loadTrim(): (cells: unknown[]) => string[] {
  const src = readFileSync(SRC, 'utf8')
  const m = src.match(/export function trimTrailingEmpty\(([\s\S]*?)\n\}/)
  if (!m) throw new Error('trimTrailingEmpty を lib.mjs から取り出せませんでした')
  const code = `
    function trimTrailingEmpty(${m[1]}
}
    return trimTrailingEmpty
  `
  return new Function(code)() as (cells: unknown[]) => string[]
}

const trim = loadTrim()

describe('trimTrailingEmpty', () => {
  it('行末の空セルだけを落とす', () => {
    expect(trim(['A', '', 'B', '', '', ''])).toEqual(['A', '', 'B'])
  })

  it('間の空セルは残す（列位置が壊れるため）', () => {
    // 「2026/4」と「Java」の間の3列は、シート上の桁そのもの
    expect(trim(['2026/4', '', '', '', 'Java'])).toEqual(['2026/4', '', '', '', 'Java'])
  })

  it('全部空なら空配列', () => {
    expect(trim(['', '　', '  '])).toEqual([])
  })

  it('空白だけのセルも空として扱う（全角スペース・タブを含む）', () => {
    expect(trim(['A', '　', '\t'])).toEqual(['A'])
  })

  it('落とすものが無ければそのまま', () => {
    expect(trim(['A', 'B'])).toEqual(['A', 'B'])
  })

  it('値は文字列化する（従来の r.map(c => String(c)) と挙動を変えない）', () => {
    // null が "null" になるのは従来どおり。worksheetToGrid は空セルを '' で返すので
    // 実データでは起きないが、**この変更で挙動を変えていない**ことを固定する
    expect(trim([2026, null, 4, ''])).toEqual(['2026', 'null', '4'])
  })

  it('空配列を渡しても落ちない', () => {
    expect(trim([])).toEqual([])
  })
})
