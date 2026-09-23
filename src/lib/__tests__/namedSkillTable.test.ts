/**
 * 保有スキル詳細テーブル型のスキル年数抽出（方式8）。
 *
 * 実害（2026-09-23 ユーザー報告・株式会社Tech Lab KY）:
 *   経歴書があるのにスキル年数が取れていなかった。DBの中身は
 *     {"環境": 30, "_extractMethod": 10}
 *   の2件だけで、「環境」は職務経歴の**行ラベル**（スキル名ではない）。
 *
 *   スキルシートにはこの表がそのまま載っていた:
 *     カテゴリ | 名称                                  | 経験年数 | レベル
 *     言語・FW | Python（業務自動化、API連携…）         | 2年以上  | ○
 *     言語・FW | Java（Spring、MyBatis）、PHP（…）      | 3年以上  | ○
 *
 *   既存方式が効かない理由:
 *     方式1（列名）は「経験年数」列を見るが **1セルに複数スキル** を想定していない。
 *     方式3（テキスト）は「スキル名 N年」の並びを見るが、ここは年数が別セル。
 *
 *   実物で 2件 → 44件 になった。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error — index.ts から自動生成した JS（型定義なし）
import { splitSkillNameCell, extractSkillYearsFromNamedTable } from '../../../scripts/_extractors.gen.mjs'

const split = (s: string): string[] => splitSkillNameCell(s) as string[]
const extract = (g: string[][]): Record<string, number> =>
  extractSkillYearsFromNamedTable(g) as Record<string, number>

describe('名称セルの分割', () => {
  it('括弧の中は内訳なので親と一緒に取り出す', () => {
    expect(split('Java（Spring、SpringBoot、MyBatis）'))
      .toEqual(['Java', 'Spring', 'SpringBoot', 'MyBatis'])
  })

  it('括弧の外の読点でだけ区切る（括弧内の読点で切らない）', () => {
    // ここを間違えると AWS（VPC…）が1つの巨大なスキル名になる
    expect(split('Java（Spring、MyBatis）、PHP（CakePHP、WordPress）'))
      .toEqual(['Java', 'Spring', 'MyBatis', 'PHP', 'CakePHP', 'WordPress'])
  })

  it('「等」「など」は名前から落とす', () => {
    expect(split('AWS（VPC、EC2、IAM 等）')).toEqual(['AWS', 'VPC', 'EC2', 'IAM'])
    expect(split('Docker、Git など')).toEqual(['Docker', 'Git'])
  })

  it('括弧なしの並びもそのまま割る', () => {
    expect(split('GAS、VBA、PowerShell、bat')).toEqual(['GAS', 'VBA', 'PowerShell', 'bat'])
  })

  it('同じ名前は1つにまとめる', () => {
    expect(split('Git、GitHub、Git')).toEqual(['Git', 'GitHub'])
  })

  it('1文字・数字だけ・句点を含む説明文は名前にしない', () => {
    expect(split('A、1、2026')).toEqual([])
    expect(split('課題を抽出します。要件定義も行います。')).toEqual([])
  })

  it('空セルでは何も返さない', () => {
    expect(split('')).toEqual([])
    expect(split('　')).toEqual([])
  })
})

describe('保有スキル詳細テーブル', () => {
  /** 実物（KY スキルシート）の該当部分 */
  const grid = [
    ['■ 保有スキル詳細', '', '', ''],
    ['カテゴリ', '名称', '経験年数', 'レベル'],
    ['言語・FW', 'Python（業務自動化、API連携）', '2年以上', '○'],
    ['言語・FW', 'Java（Spring、MyBatis）、PHP（CakePHP）', '3年以上', '○'],
    ['言語・FW', 'GAS、VBA、PowerShell、bat', '5年以上', '◎'],
    ['クラウド', 'AWS（VPC、EC2、RDS、S3、Lambda 等）', '2年以上', '○'],
    ['ツール', 'Terraform、GitHub Actions、Docker', '1年以上', '○'],
  ]

  const got = extract(grid)

  it('年数を月に直して全スキルに配る', () => {
    expect(got['Python']).toBe(24)
    expect(got['Java']).toBe(36)
    expect(got['PHP']).toBe(36)
    expect(got['AWS']).toBe(24)
    expect(got['Terraform']).toBe(12)
  })

  it('括弧の中の技術にも親と同じ年数を与える', () => {
    expect(got['Spring']).toBe(36)
    expect(got['MyBatis']).toBe(36)
    expect(got['EC2']).toBe(24)
    expect(got['Lambda']).toBe(24)
  })

  it('「N年以上」を N年 として読む', () => {
    expect(got['GAS']).toBe(60)
    expect(got['VBA']).toBe(60)
  })

  it('見出しが揃っていない表では動かない（職務経歴の「環境」行を拾わない）', () => {
    // これを取ってしまい {"環境":30} だけが入っていた
    const career = [
      ['No.1', '2025/06 〜 2026/06（1年1ヶ月）'],
      ['環境', 'AWS、Terraform、Python、Docker、Linux、MySQL'],
      ['作業内容', '・AWS基盤の刷新 ・監視設計'],
    ]
    expect(extract(career)).toEqual({})
  })

  it('名称だけ・経験年数だけの表でも動かない', () => {
    expect(extract([['名称', 'レベル'], ['Java', '○']])).toEqual({})
    expect(extract([['カテゴリ', '経験年数'], ['言語', '3年']])).toEqual({})
  })

  it('同じスキルが複数行に出たら長い方を採る', () => {
    const g = [
      ['名称', '経験年数'],
      ['Java', '2年'],
      ['Java（Spring）', '5年'],
    ]
    expect(extract(g)['Java']).toBe(60)
  })

  it('人として有り得ない年数は捨てる', () => {
    expect(extract([['名称', '経験年数'], ['COBOL', '90年']])['COBOL']).toBeUndefined()
  })
})
