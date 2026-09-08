/**
 * 見出し語を人名として採らない判定（inbound-email の isLabelWordName）の回帰テスト。
 *
 * prod 実測（2026-09-09）で、氏名が見出し語そのものの人材が4件いた
 * （「氏名」「フリガナ」「生年月日」「No」）。Excel の見出し行が1人として登録されている。
 * `looksLikeRosterName` は名簿展開の経路にしか掛からず、本文ブロックや
 * `extractNameFallback` の経路は素通りしていた。
 *
 * レプリカは作らず、**本番に出す index.ts から関数を切り出して**検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadGate(): (v: string | null | undefined) => boolean {
  const src = readFileSync(SRC, 'utf8')
  const m = src.match(/function isLabelWordName\(([\s\S]*?)\n\}/)
  if (!m) throw new Error('isLabelWordName を index.ts から取り出せませんでした')
  const code = `
    ${`function isLabelWordName(${m[1]}\n}`
      .replace(/: string \| null \| undefined/g, '')
      .replace(/: boolean/g, '')}
    return isLabelWordName
  `
  return new Function(code)() as (v: string | null | undefined) => boolean
}

const isLabel = loadGate()

describe('isLabelWordName', () => {
  it('prod で実際に人材になっていた見出し語を弾く', () => {
    for (const ng of ['氏名', 'フリガナ', '生年月日', 'No']) {
      expect(isLabel(ng), ng).toBe(true)
    }
  })

  it('Excel の他の見出しも弾く', () => {
    for (const ng of ['ふりがな', '年齢', '性別', '住所', '最寄駅', '国籍', '経験年数',
                      'スキル', '希望単価', '備考', '専攻学科', '最終学歴', '保有資格',
                      '会社名', '所属', '自己PR', '稼働時期', 'ステータス', '番号']) {
      expect(isLabel(ng), ng).toBe(true)
    }
  })

  it('スペース・コロン付きの見出しも弾く', () => {
    for (const ng of ['氏　名', '氏名：', '氏 名 :', 'フリ ガナ']) {
      expect(isLabel(ng), ng).toBe(true)
    }
  })

  it('空・null は人名ではない', () => {
    for (const ng of ['', '　', null, undefined]) {
      expect(isLabel(ng), JSON.stringify(ng)).toBe(true)
    }
  })

  it('本物の人名は通す', () => {
    for (const ok of ['田中太郎', '田中 太郎', 'K.T', 'A.M', '楊F', '李A（リ）',
                      'Tanaka Taro', '中村 学', '氏原', '名波', '高齢']) {
      expect(isLabel(ok), ok).toBe(false)
    }
  })
})
