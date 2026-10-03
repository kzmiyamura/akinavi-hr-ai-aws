/**
 * 氏名として成立しているかの判定（scripts/lib/bad_names.mjs）のテスト。
 *
 * この規則は2か所から使われる:
 *   - scripts/audit_bad_names.mjs（prod を全件引く監査）
 *   - scripts/selfcheck/detectors/bad_names.mjs（控えで回る夜間健診の検出器⑤）
 *
 * ⚠ **本物の人を「名前じゃない」と言う誤りが一番高い。** 営業が本人の行を
 *    疑う材料になるので、実名が通ることを先に守る。
 */
import { describe, it, expect } from 'vitest'
import { badNameReasons } from '../../../scripts/lib/bad_names.mjs'

describe('氏名として成立する（所見にしない）', () => {
  it('ふつうの日本語氏名', () => {
    expect(badNameReasons('山田 太郎')).toEqual([])
  })
  it('イニシャル氏名（prod の大半がこの形）', () => {
    expect(badNameReasons('K.H')).toEqual([])
  })
  it('半角カナの読みが付いた実名', () => {
    // 控えの実測（2026-10-03）に実在した `呂V（ﾛ）`。半角カナを「文字」に
    // 含めていなかった時期は**実名が「文字なし」になっていた**
    expect(badNameReasons('呂V（ﾛ）')).toEqual([])
  })
  it('半角カナだけの氏名でも「文字なし」にしない', () => {
    expect(badNameReasons('ﾀﾅｶ ﾀﾗｳ')).toEqual([])
  })
  it('全角の「カナ」は実在する下の名前なので見出し語扱いしない', () => {
    expect(badNameReasons('カナ')).toEqual([])
  })
})

describe('氏名として成立しない', () => {
  it('空は「空」だけを返して打ち切る', () => {
    expect(badNameReasons('')).toEqual(['空'])
    expect(badNameReasons(null)).toEqual(['空'])
    expect(badNameReasons(undefined)).toEqual(['空'])
  })
  it('元号つきの生年月日（全角数字も同時に付く）', () => {
    expect(badNameReasons('昭和３３年５月１３日')).toEqual(['全角数字', '元号(生年月日)'])
  })
  it('年齢・性別を巻き込んだ氏名', () => {
    expect(badNameReasons('KH（男性・39歳）')).toEqual(['半角数字'])
  })
  it('スキル分類がそのまま名前になっている', () => {
    expect(badNameReasons('オープン系')).toEqual(['スキル分類'])
  })
  it('表の見出しが1人目として登録されている', () => {
    // 控えの実測（2026-10-03）で `氏名` / `フリガナ` / `ｶﾅ` が prod に5人いた
    for (const h of ['氏名', '名前', 'フリガナ', 'ふりがな', 'ﾌﾘｶﾞﾅ', 'ｶﾅ', '不明']) {
      expect(badNameReasons(h), h).toEqual(['プレースホルダ'])
    }
  })
  it('記号だけ', () => {
    expect(badNameReasons('―――')).toEqual(['文字なし'])
  })
  it('長すぎるものは字数を文面に入れる（経歴の一行が入っている）', () => {
    const r = badNameReasons('I.Tリーダー/サブリーダー経験あり　ベテランエンジニア')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/^長すぎる\(\d+字\)$/)
  })
  it('20字はまだ通し、21字から出す（境界）', () => {
    expect(badNameReasons('あ'.repeat(20))).toEqual([])
    expect(badNameReasons('あ'.repeat(21))).toEqual(['長すぎる(21字)'])
  })
})

describe('検出器が指紋を丸める前提', () => {
  /**
   * 検出器⑤は理由を `reason.replace(/\(\d+字\)/, '')` で丸めて束ねる。
   * 字数が理由文に残り続けることがこの丸めの前提なので、ここで固定する。
   */
  it('「長すぎる」だけが可変部分を持つ', () => {
    const variable = ['全角数字', '半角数字', '元号(生年月日)', 'スキル分類', 'プレースホルダ', '文字なし', '空']
    for (const v of variable) expect(v).not.toMatch(/\(\d+字\)/)
    expect(badNameReasons('x'.repeat(25))[0]).toMatch(/\(25字\)/)
  })
})
