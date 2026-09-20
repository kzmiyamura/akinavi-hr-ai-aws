/**
 * 「人が1人も取れていないなら人材として登録しない」門番（inbound-email の NO_PERSON_FOUND）。
 *
 * 実害（2026-09-20 ユーザー報告）: JCB を騙るフィッシングメールが人材として登録された。
 *   件名「MyJCBシステム更新に伴うお客様情報の再確認について」
 *   From  noreply@mail11.qimeihulian.com
 *   会社名「株式会社セブン・カードサービス発行」／スキル Windows・F5 BIG-IP・Word／業界 金融
 * すべて本文末尾の規約文から拾ったもので、人は1人も書かれていない。
 * 実測で prod 3,007人中51人がこの形だった。
 *
 * 入口で止まらなかった理由:
 *   preFilterEmail の判定は unknown → Gemini 分類へ。
 *   classifyEmailsBatch は失敗すると全件を candidate にして返す（記録も残さない）。
 *   なので「分類が何を言おうと、人がいなければ登録しない」を最後に置いた。
 *
 * ここで守りたいのは **本物の人材を落とさないこと**。
 * 氏名・年齢・性別・単価・最寄駅・経験年数のどれか1つでもあれば通す。
 *
 * レプリカは作らず、本番に出す index.ts から条件式を切り出して検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

/** index.ts の判定条件をそのまま関数化する（式を書き写さない） */
function loadGate() {
  const src = readFileSync(SRC, 'utf8')
  if (!src.includes("respondSkipped('NO_PERSON_FOUND'")) {
    throw new Error('NO_PERSON_FOUND の門番が index.ts に見つかりません')
  }
  const m = src.match(/const nameUsable = ([\s\S]*?)\n\s*if \(!nameUsable && !hasAnyPersonAttr\)/)
  if (!m) throw new Error('判定条件を取り出せませんでした')
  const body = `const nameUsable = ${m[1]}\nreturn !nameUsable && !hasAnyPersonAttr`
  // 変数名を引数に寄せる
  return new Function('resolvedName', 'analyzed', 'regexFields', 'resolvedDesiredRate',
    'resolvedStation', 'resolvedExperienceYears', body) as (
      resolvedName: string,
      analyzed: Record<string, unknown>,
      regexFields: Record<string, unknown>,
      resolvedDesiredRate: unknown,
      resolvedStation: unknown,
      resolvedExperienceYears: number | null,
    ) => boolean
}

const isNotPerson = loadGate()
const call = (o: {
  name?: string; age?: number | null; gender?: string | null
  rate?: string | null; station?: string | null; exp?: number | null
}) => isNotPerson(
  o.name ?? '不明',
  {},
  { age: o.age ?? null, gender: o.gender ?? null },
  o.rate ?? null,
  o.station ?? null,
  o.exp ?? null,
)

describe('NO_PERSON_FOUND の門番', () => {
  it('氏名も属性も無いものは人材ではない（フィッシング等）', () => {
    expect(call({})).toBe(true)
    expect(call({ name: '氏名未取得' })).toBe(true)
    expect(call({ name: '' })).toBe(true)
    expect(call({ name: '   ' })).toBe(true)
  })

  it('氏名があれば通す', () => {
    expect(call({ name: 'K.T' })).toBe(false)
    expect(call({ name: '田中太郎' })).toBe(false)
  })

  it('氏名が無くても属性が1つでもあれば通す（本物を落とさない）', () => {
    expect(call({ age: 36 }), '年齢').toBe(false)
    expect(call({ gender: '男性' }), '性別').toBe(false)
    expect(call({ rate: '75万' }), '単価').toBe(false)
    expect(call({ station: '盛岡駅' }), '最寄駅').toBe(false)
    expect(call({ exp: 12 }), '経験年数').toBe(false)
  })

  it('年齢0・経験年数0 を「無い」と取り違えない', () => {
    // 0 は falsy。!! で判定すると属性なし扱いになり、本物を落とす
    expect(call({ age: 0 })).toBe(false)
    expect(call({ exp: 0 })).toBe(false)
  })
})
