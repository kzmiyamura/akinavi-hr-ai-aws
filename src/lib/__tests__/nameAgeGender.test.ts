/**
 * 氏名欄からの年齢・性別の取り出しの回帰テスト。
 *
 * 2026-09-17、名簿の採点（quality_truth_roster.mjs）で見つかった抜け。
 * ウェブボルトの3人メールが**全員 gender が null** だった:
 *
 *   本文: 【名 前】TS：57才(男性)
 *   DB  : 氏名「TS」/ 年齢 57 / 性別 null
 *
 * 原因は stripInitialSuffix。「TS：57才(男性)」を "TS" に切ってから
 * 年齢・性別を探しており、探す先に性別が残っていなかった。
 * 関数の中に「年齢・性別が続くなら切らない」を足すと、今度は氏名が
 * "TS：57才" になる（括弧の外の "：57才" は他の規則が落とさない）。
 * そこで **氏名は切ったあと・年齢と性別は切る前** から取るようにした。
 *
 * レプリカは作らず、本番に出す index.ts から該当区間を切り出して検証する
 * （nearestStationField.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// @ts-expect-error 生成物に型定義は無い（index.ts から自動生成）
import { stripInitialSuffix } from '../../../scripts/_extractors.gen.mjs'

const SRC = readFileSync(
  resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'), 'utf8')

/** 年齢・性別の判定区間を index.ts から切り出す */
function cutAgeGenderBlock(): string {
  const start = SRC.indexOf('  const nameBeforeStrip = cleanedName')
  const end = SRC.indexOf('  // ── 独立した「年齢：」「性別：」ラベルからのフォールバック', start)
  if (start < 0 || end < 0) throw new Error('年齢・性別の判定区間を index.ts から取り出せませんでした')
  return SRC.slice(start, end)
}

const block = cutAgeGenderBlock()

const run = new Function('stripInitialSuffix', `
  return (rawName) => {
    let cleanedName = rawName
${block
    .replace(/let age: number \| null = null/, 'let age = null')
    .replace(/let gender: string \| null = null/, 'let gender = null')
    .replace(/let nationality: string \| null = null/, 'let nationality = null')
    .replace(/^  \/\*\*[\s\S]*?\*\/$/gm, '')}
    return { name: nameStripped, age, gender, nationality }
  }
`)(stripInitialSuffix) as (raw: string) => { name: string; age: number | null; gender: string | null; nationality: string | null }

describe('氏名欄に「：年齢才(性別)」が続く形（ウェブボルト・2026-09-17 実測）', () => {
  it('氏名は切り、年齢と性別は拾う', () => {
    expect(run('TS：57才(男性)')).toMatchObject({ name: 'TS', age: 57, gender: '男性' })
  })

  it('半角コロン・歳・女性でも同じ', () => {
    expect(run('TA:58歳(女性)')).toMatchObject({ name: 'TA', age: 58, gender: '女性' })
  })

  it('氏名に年齢の数字を混ぜない', () => {
    expect(run('TS：57才(男性)').name).not.toMatch(/57|男性|：/)
  })
})

describe('既存の形を壊していないこと', () => {
  it('(26歳/男性) — 年齢が先', () => {
    expect(run('K.T（26歳/男性）')).toMatchObject({ name: 'K.T', age: 26, gender: '男性' })
  })

  it('（男性/40歳） — 性別が先', () => {
    expect(run('K.H（男性/40歳）')).toMatchObject({ name: 'K.H', age: 40, gender: '男性' })
  })

  it('（男性/48歳、中国） — 国籍つき', () => {
    expect(run('M.S（男性/48歳、中国）')).toMatchObject({ age: 48, gender: '男性', nationality: '中国' })
  })

  it('YS(26歳) — 年齢だけ', () => {
    expect(run('YS(26歳)')).toMatchObject({ name: 'YS', age: 26, gender: null })
  })

  it('T.N（34） — 才歳なしの2桁', () => {
    expect(run('T.N（34）')).toMatchObject({ name: 'T.N', age: 34 })
  })

  it('管理番号つきの呼称は切らず、年齢も性別も作らない', () => {
    expect(run('IC023009')).toMatchObject({ name: 'IC023009', age: null, gender: null })
    expect(run('IT-OGK')).toMatchObject({ name: 'IT-OGK', age: null, gender: null })
  })

  it('年齢に見える数字でも人の年齢の範囲外なら採らない', () => {
    // 「KM29蕨」は従来どおり "KM" に切る（29は年齢ではなく駅名の巻き込み）
    expect(run('KM29蕨').age).toBeNull()
  })
})
