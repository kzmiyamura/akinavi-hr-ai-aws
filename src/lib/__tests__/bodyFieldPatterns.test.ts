/**
 * メール本文からの氏名・性別・年齢・希望単価の抽出パターンの回帰テスト。
 *
 * 2026-09-14、**ローカルに残した原本と本番DBを突き合わせて**見つかった抜け。
 * 品質チェックSQLでは「経験年数が null の人が110人」までしか分からず、
 * 「入っている値が間違っている」は見つけられなかった。
 * claude -p に原文を読ませて正解を作り、DBと比べて初めて出てきた:
 *
 *   本文: ・Ｉ．Ｙ（男性）… 51才 … 希望 57万／月（精算要） … 代々木公園駅
 *   DB  : 氏名「H」（別人）/ 年齢 null / 性別 null / 希望単価 null
 *
 * レプリカは作らず、**本番に出す index.ts から正規表現を切り出して**検証する
 * （scripts/test_extraction.mjs は手書きレプリカなので、ここでは使えない）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function pick(name: string): RegExp {
  const src = readFileSync(SRC, 'utf8')
  const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[gimsuy]*)\\r?\\n`))
  if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
  // eslint-disable-next-line no-eval
  return eval(m[1]) as RegExp
}

const RATE = pick('RATE_STANDALONE_RE')
const NAME_GENDER = pick('NAME_GENDER_ONLY_RE')
const AGE_ALONE = pick('AGE_ALONE_RE')

/** 実際に取りこぼした本文（2026-09-13 受信・アイビーエス） */
const REAL_BODY = [
  '協力会社様から下記の技術者の方の紹介が御座いました。',
  '・Ｉ．Ｙ（男性）　JP1 Firmware L2/L3SW IPX IGX MGX',
  '　　　　　　　　　51才　10月～　希望 57万／月（精算要）※調整可能',
  '　　　　　　　　　千代田線／代々木公園駅',
].join('\n')

describe('希望単価（単独値）', () => {
  it('全角スラッシュの「57万／月」を取れる（これが取れず希望案件に化けていた）', () => {
    expect(REAL_BODY.match(RATE)?.[1]).toBe('57')
  })

  it('半角スラッシュも従来どおり取れる', () => {
    expect('希望 60万/月'.match(RATE)?.[1]).toBe('60')
  })

  it('以上・程度・台も取れる', () => {
    expect('65万円以上'.match(RATE)?.[1]).toBe('65')
    expect('70万程度'.match(RATE)?.[1]).toBe('70')
    expect('80万台'.match(RATE)?.[1]).toBe('80')
  })

  it('単位が無ければ拾わない（「57万」だけでは単価と断定しない）', () => {
    expect('希望 57万'.match(RATE)).toBeNull()
  })
})

describe('氏名＋性別（括弧に性別だけ）', () => {
  it('「・Ｉ．Ｙ（男性）」から氏名と性別を取れる', () => {
    const m = REAL_BODY.match(NAME_GENDER)
    expect(m?.[1]).toBe('Ｉ．Ｙ')
    expect(m?.[2]).toBe('男性')
  })

  it('行頭の装飾が無くても取れる', () => {
    const m = 'A.S（女性）'.match(NAME_GENDER)
    expect(m?.[1]).toBe('A.S')
    expect(m?.[2]).toBe('女性')
  })

  it('■ 等の既存の装飾も引き続き認める', () => {
    expect('■C-TN（男）'.match(NAME_GENDER)?.[1]).toBe('C-TN')
  })

  it('括弧の中が性別でなければ拾わない', () => {
    expect('株式会社テスト（東京）'.match(NAME_GENDER)).toBeNull()
  })

  it('名前が数字だけの行は拾わない', () => {
    expect('0004（男性）'.match(NAME_GENDER)).toBeNull()
  })
})

describe('単独の年齢', () => {
  it('「51才」を取れる', () => {
    expect(REAL_BODY.match(AGE_ALONE)?.[1]).toBe('51')
  })

  it('「45歳」も取れる', () => {
    expect('　　45歳　'.match(AGE_ALONE)?.[1]).toBe('45')
  })

  it('「20代」を年齢にしない', () => {
    expect('20代前半'.match(AGE_ALONE)).toBeNull()
  })

  it('「30歳以上」を年齢にしない（案件の条件であって本人の年齢ではない）', () => {
    expect('30歳以上'.match(AGE_ALONE)).toBeNull()
  })
})
