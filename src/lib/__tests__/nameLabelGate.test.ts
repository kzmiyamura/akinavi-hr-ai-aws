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

  it('スキルシートの見出し語も弾く（2026-09-18 画面で発見）', () => {
    // 実害: (株)Dearism の1通で氏名が「専門分野」。本文には ≪N.M (36歳) 男性≫ とあり
    // extractNameFallback は "N.M" を返せていたのに、添付から拾った見出し語が先に採用された。
    // ここで弾けば本文のイニシャルに落ちる。
    for (const ng of ['専門分野', '得意分野', '対応分野', '専門',
                      '職種', '業種', '業務', '業務内容',
                      '工程', '対応工程', '担当工程', '作業工程', '担当業務',
                      '開発言語', '使用言語', '言語', '保有技術', '技術',
                      '開発環境', '使用環境', '環境', 'ツール', 'フレームワーク',
                      '職務経歴', '経歴', '履歴', '実績', '概要', '要約', 'サマリー',
                      '特記事項', '種別', '属性', '内容', '詳細', '情報', '一覧', 'その他']) {
      expect(isLabel(ng), ng).toBe(true)
    }
  })

  it('1字の語は入れない（本物の人名を消すため）', () => {
    // 「中村 学」「望」のような1字名が実在する。完全一致なので1字を足すと本人が消える
    for (const ok of ['学', '望', '環', '技', '実', '詳', '情']) {
      expect(isLabel(ok), ok).toBe(false)
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
