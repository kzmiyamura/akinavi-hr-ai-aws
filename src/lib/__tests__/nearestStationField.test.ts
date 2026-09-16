/**
 * 最寄駅のラベル抽出（inbound-email の 最寄駅ブロック）の回帰テスト。
 *
 * 2026-09-17 実測: 品質チェック（実メール25通）で最寄駅の正答率が 84% で、
 * 「本文にあるのにDBが空」が4件あった。実物はこれ:
 *
 *   最 寄 駅：京王線　八幡山駅　リモート併用案件希望　※通勤30分以内であれば常駐可
 *
 * 原因は2つで、どちらも**駅名の読み取りではなく受け入れ条件**の側だった:
 *   1. 値が35文字あり `maxLen = 30` で先に落ちていた（check() は validate より先に長さを見る）
 *   2. validate が `[駅線]$`（駅で終わること）を要求しており、注記が付くと弾いていた
 * 駅名の切り出し自体は parseNearestStation が正しく行える（下のテストで確認）。
 *
 * ⚠ レプリカは作らない。**本番に出す index.ts から切り出して**検証する
 *   （nationalityGate.test.ts / companyName.test.ts と同じ方式）。
 * ⚠ extractFieldTwoPhase は `scripts/sync_extractors.mjs` には足せない。
 *   引数の `validate?: (v: string) => boolean` を型除去の規則が落とせず、
 *   生成ファイル全体が壊れる（2026-09-17 に試して戻した）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'), 'utf8')

/** index.ts から関数を1つ、本文ごと切り出す */
function cut(name: string): string {
  const i = SRC.indexOf(`function ${name}(`)
  if (i < 0) throw new Error(`${name} を index.ts から取り出せませんでした`)
  const end = SRC.indexOf('\n}', i)
  if (end < 0) throw new Error(`${name} の終端が見つかりませんでした`)
  return SRC.slice(i, end + 2)
}

/** TypeScript の型注釈のうち、この2関数に出てくる形だけを落とす */
const stripTypes = (s: string): string => s
  .replace(/validate\?\s*:\s*\(v:\s*string\)\s*=>\s*boolean/g, 'validate')
  .replace(/\)\s*:\s*string(?:\s*\|\s*null)?\s*(?=\{)/g, ') ')
  .replace(/\)\s*:\s*string(?:\s*\|\s*null)?\s*(?==>)/g, ') ')
  .replace(/:\s*string\[\]/g, '')
  .replace(/:\s*string(?:\s*\|\s*null)?(?=\s*[,)=])/g, '')

/** 最寄駅ブロックから、実際に使われている validate と maxLen を取り出す */
function cutStationArgs(): { validateSrc: string; maxLen: number; minLen: number } {
  const i = SRC.indexOf('  // ── 最寄駅 ')
  if (i < 0) throw new Error('最寄駅ブロックを index.ts から取り出せませんでした')
  const block = SRC.slice(i, i + 3000)
  const vStart = block.indexOf('v => {')
  const vEnd = block.indexOf('\n    },', vStart)
  if (vStart < 0 || vEnd < 0) throw new Error('最寄駅の validate を取り出せませんでした')
  const validateSrc = block.slice(vStart, vEnd + 6)
  // validate の直後に並ぶ2つの数値引数（maxLen, phase3MinLen）。行コメントは飛ばす
  const after = block.slice(vEnd + 6)
  const nums = [...after.matchAll(/^\s*(\d+),\s*$/gm)].map(m => Number(m[1]))
  if (nums.length < 2) throw new Error('最寄駅の maxLen / minLen を取り出せませんでした')
  return { validateSrc, maxLen: nums[0], minLen: nums[1] }
}

const { validateSrc, maxLen, minLen } = cutStationArgs()

const extractStation = new Function(`
  ${stripTypes(cut('flexLabel'))}
  ${stripTypes(cut('extractFieldTwoPhase'))}
  const validate = ${validateSrc.replace(/,$/, '')}
  return (body) => extractFieldTwoPhase(
    ['最寄り?駅','最寄駅','最寄り?','沿線','通勤駅'], body, '', validate, ${maxLen}, ${minLen})
`)() as (body: string) => string | null

describe('最寄駅ラベルの受け入れ条件', () => {
  it('切り出しが成立している（コードが動いたら落ちて気付けるように固定する）', () => {
    expect(maxLen).toBeGreaterThanOrEqual(60)   // 35文字の実データが通る余地
    expect(minLen).toBe(2)                       // 「渋谷」「大阪」等の2文字駅名
  })

  it('★駅名のうしろに注記が続いても捨てない（2026-09-17 実データ）', () => {
    const body = '名    前：KK\n年    齢：30歳\n'
      + '最 寄 駅：京王線　八幡山駅　リモート併用案件希望　※通勤30分以内であれば常駐可\n'
      + '単    価：78万円\n'
    const raw = extractStation(body)
    expect(raw, '値ごと捨てられている').not.toBeNull()
    expect(raw).toContain('八幡山駅')
  })

  it('注記のいろいろな形', () => {
    for (const line of [
      '最寄駅：相鉄線　さがみ野駅　※リモート希望',
      '最寄駅：都営大江戸線 落合南長崎駅 徒歩5分',
      '最寄駅：小田急線　長後駅（相模本線 さがみ野駅も利用可）',
      '【最　寄】：京王線　八幡山駅',
      '最寄駅：京王線　八幡山駅',
    ]) {
      expect(extractStation(line + '\n'), line).not.toBeNull()
    }
  })

  it('セクション見出しは従来どおり駅名にしない', () => {
    for (const line of ['最寄駅：自己PR', '最寄駅：スキル', '最寄駅：備考']) {
      expect(extractStation(line + '\n'), line).toBeNull()
    }
  })
})
