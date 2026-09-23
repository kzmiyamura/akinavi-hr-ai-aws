/**
 * 名簿行に**素のテキストとして**書かれた経歴書URLを拾えるか。
 *
 * 実害（2026-09-23 ユーザー報告「直近の人材に経歴書のリンクが全然ない」）:
 *   13:15 に株式会社D-code から届いた1通で56人が登録されたが、53人にリンクが無かった。
 *   メール本文は1人分（MK・葛西駅）で、添付も MK のスキルシート1枚だけ。
 *   残りの人は本文に貼られた名簿スプレッドシートから取り込まれていた。
 *
 *   その名簿を開いたところ **D列の見出しが「経歴書」で、140人中133人(95%)にURLがあった**。
 *   取引先はきちんと載せていたのに、こちらが1件も拾えていなかった。
 *
 *   原因は拾い方。`detectRoster` は `entry.links`（セルのハイパーリンク）だけを
 *   行に紐づけていたが、**Googleスプレッドシートを xlsx 出力すると、
 *   文字列として入力したURLはハイパーリンクにならない**。
 *   実測: この名簿はハイパーリンク 0件 / 素のテキストURL 133件。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error — index.ts から自動生成した JS（型定義なし）
import { bareResumeUrlsInRow, colLettersFromIndex } from '../../../scripts/_extractors.gen.mjs'

type Link = { cell: string; url: string }
const urls = (row: string[], rowIndex = 0): string[] =>
  (bareResumeUrlsInRow(row, rowIndex) as Link[]).map(l => l.url)

describe('名簿行の素のテキストURL', () => {
  it('実データの行から経歴書URLを拾う（Drive）', () => {
    // 「弊社個人（開発）」D2 の実値
    const row = ['EM', 'Swift, C#', '■氏 名：EM(男性/35歳) ■最 寄：上石神井駅',
      'https://drive.google.com/file/d/17Ii-W-8PKeBoG1IX8t7zMUS9Wkp2YLQl/view']
    expect(urls(row)).toEqual(
      ['https://drive.google.com/file/d/17Ii-W-8PKeBoG1IX8t7zMUS9Wkp2YLQl/view'])
  })

  it('実データの行から経歴書URLを拾う（スプレッドシート）', () => {
    const row = ['KK', 'C#, .NET, VB', '■氏 名：KK(男性/62歳)',
      'https://docs.google.com/spreadsheets/d/1Xdx4Uf6gPNaqejNTlld9_nm6sbKbO9x/edit#gid=0']
    expect(urls(row)).toEqual(
      ['https://docs.google.com/spreadsheets/d/1Xdx4Uf6gPNaqejNTlld9_nm6sbKbO9x/edit#gid=0'])
  })

  it('セル参照は列文字＋1始まりの行番号（既存のリンクと同じ形）', () => {
    const row = ['MK', '', '', 'https://drive.google.com/file/d/1abcdefghijklmnopqrstuvwxyz/view']
    // D列（index 3）、グリッド index 70 → 71行目
    expect((bareResumeUrlsInRow(row, 70) as Link[])[0].cell).toBe('D71')
  })

  it('経歴書ではないURLは拾わない（会社HP・LINE・配信停止）', () => {
    const row = ['AK', '', 'https://code-d.co.jp/', 'https://line.me/R/ti/p/@001szlar',
      'https://example.com/unsubscribe?id=123']
    expect(urls(row)).toEqual([])
  })

  it('Googleドキュメントも拾う', () => {
    const row = ['TS', '', 'https://docs.google.com/document/d/1zzzzzzzzzzzzzzzzzzzzzzzzz/edit']
    expect(urls(row)).toHaveLength(1)
  })

  it('URLの後ろの閉じ括弧や句読点を含めない', () => {
    const row = ['YY', '経歴書（https://drive.google.com/file/d/1aaaaaaaaaaaaaaaaaaaaaa/view）です']
    expect(urls(row)).toEqual(
      ['https://drive.google.com/file/d/1aaaaaaaaaaaaaaaaaaaaaa/view'])
  })

  it('同じURLが複数セルにあっても1件にまとめる', () => {
    const u = 'https://drive.google.com/file/d/1bbbbbbbbbbbbbbbbbbbbbb/view'
    expect(urls(['AA', u, u, u])).toEqual([u])
  })

  it('URLが無い行・空の行では何も返さない', () => {
    expect(urls(['NN', '35歳', '品川駅', ''])).toEqual([])
    expect(urls([])).toEqual([])
  })

  it('http（非https）のGoogleリンクは拾わない（名簿の実データは全てhttps）', () => {
    expect(urls(['XX', 'http://drive.google.com/file/d/1ccccccccccccccccccccc/view'])).toEqual([])
  })

  it('列文字の変換（26列目以降もずれない）', () => {
    expect(colLettersFromIndex(0)).toBe('A')
    expect(colLettersFromIndex(3)).toBe('D')
    expect(colLettersFromIndex(25)).toBe('Z')
    expect(colLettersFromIndex(26)).toBe('AA')
    expect(colLettersFromIndex(51)).toBe('AZ')
    expect(colLettersFromIndex(52)).toBe('BA')
  })
})
