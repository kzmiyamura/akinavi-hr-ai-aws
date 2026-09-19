/**
 * 画面に出す氏名の整形（inbound-email の cleanDisplayName）。
 *
 * prod 実測（2026-09-19・3,008人）で、氏名に数字が混ざっているのが85人いた。内訳:
 *   約75人  「KS（30歳男性）」「HS（男性・31歳）」… 年齢・性別が氏名欄に残っている
 *     6人  「24_17_KS加」                        … 名簿の行番号が前に付いている
 *     3人  「NH640」「N57」                      … 送信元の管理番号
 *     数人  「OS※23年1ヶ月」「OY（40歳」        … 注記・閉じ括弧の欠け
 *
 * 年齢・性別の括弧を残していたのは「切ると抽出が失敗する」ためだったが、
 * 抽出は切る前の文字列（ageGenderSrc）から読むよう変えたので、その前提は無い。
 *
 * ここで守りたいのは **但し書きと人名を消さない** こと。
 * 「NK（長野に引っ越し予定）」の括弧を落とすと、営業が見る情報が減る。
 *
 * レプリカは作らず、本番に出す index.ts から関数を切り出して検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadClean(): (s: string) => string {
  const src = readFileSync(SRC, 'utf8')
  const m = src.match(/function cleanDisplayName\(([\s\S]*?)\n\}/)
  if (!m) throw new Error('cleanDisplayName を index.ts から取り出せませんでした')
  const js = `function cleanDisplayName(${m[1]}\n}\nreturn cleanDisplayName`
    .replace(/:\s*string/g, '')
  return new Function(js)() as (s: string) => string
}

const clean = loadClean()

describe('cleanDisplayName', () => {
  it('年齢・性別の括弧を落とす（prod 実データ・約75人）', () => {
    const cases: Array<[string, string]> = [
      ['HS（男性・31歳）', 'HS'],
      ['KS（30歳男性）', 'KS'],
      ['KT（28歳・男性）', 'KT'],
      ['K.S（女性・34歳）', 'K.S'],
      ['SK(男性・25歳)', 'SK'],
      ['HN（59歳・男性）', 'HN'],
      ['HY（31歳女性）', 'HY'],
      ['AM（37歳男性）', 'AM'],
    ]
    for (const [input, want] of cases) expect(clean(input), input).toBe(want)
  })

  it('閉じ括弧が無いものも落とす', () => {
    expect(clean('OY（40歳')).toBe('OY')
  })

  it('国籍だけの括弧も落とす', () => {
    expect(clean('TN（中国籍）')).toBe('TN')
    expect(clean('YM（男性・28歳・日本）')).toBe('YM')
  })

  it('名簿の行番号を落とす（prod 実データ・6人）', () => {
    expect(clean('24_17_KS加')).toBe('KS加')
    expect(clean('25_171_KA金')).toBe('KA金')
    expect(clean('6_24_YY山')).toBe('YY山')
  })

  it('※以降の注記を落とす', () => {
    expect(clean('OS※23年1ヶ月')).toBe('OS')
    expect(clean('IT ※弊社実績あり')).toBe('IT')
  })

  it('管理番号を落とす（prod 実データ・3人）', () => {
    expect(clean('NH640')).toBe('NH')
    expect(clean('IC023009')).toBe('IC')
    expect(clean('OS026007')).toBe('OS')
  })

  it('但し書きの括弧は残す（消すと営業が見る情報が減る）', () => {
    expect(clean('NK（長野に引っ越し予定）')).toBe('NK（長野に引っ越し予定）')
    expect(clean('TA（リモート希望）')).toBe('TA（リモート希望）')
  })

  it('本物の人名は1文字も変えない', () => {
    for (const ok of ['田中太郎', '田中 太郎', 'K.T', 'A.M', '楊F', '中村 学',
                      'Tanaka Taro', '李A（リ）', 'N.M']) {
      expect(clean(ok), ok).toBe(ok)
    }
  })

  it('不明・空はそのまま', () => {
    expect(clean('不明')).toBe('不明')
    expect(clean('')).toBe('')
  })

  it('落とし切って空になるなら元に戻す（氏名を消さない）', () => {
    // 「（男性・31歳）」だけの名前は括弧を落とすと空になる。空の氏名を作らない
    expect(clean('（男性・31歳）')).toBe('（男性・31歳）')
  })
})
