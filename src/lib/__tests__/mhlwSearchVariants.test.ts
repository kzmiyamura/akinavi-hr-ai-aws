/**
 * 厚労省サイトへ投げる検索キーの回帰テスト。
 *
 * このサイトは事業主名を全角英数字で保持しており（「株式会社ＧＦＤ」）、部分一致検索は
 * 文字種を吸収しない。半角のまま引くと0件になり、それを「免許なし」と記録していたため、
 * 実在の派遣元が赤字で「免許なし」と表示され、派遣案件のマッチングからも落ちていた。
 * 検索キーの作り方はこの機能の生命線なので、ここで固定する。
 *
 * レプリカは作らず、**本番に出す index.ts から関数を切り出して**検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/verify-agent-license/index.ts')

function load() {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name: string) => {
    const m = src.match(new RegExp(`export function ${name}\\(([\\s\\S]*?)\\n\\}`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return `function ${name}(${m[1]}\n}`
      .replace(/: string\[\]/g, '')
      .replace(/: string \| null/g, '')
      .replace(/: string/g, '')
  }
  const code = `
    ${pick('toFullWidth')}
    ${pick('normalizeForSearch')}
    ${pick('stripCorp')}
    ${pick('searchVariants')}
    return { toFullWidth, normalizeForSearch, stripCorp, searchVariants }
  `
  return new Function(code)() as {
    toFullWidth: (s: string) => string
    normalizeForSearch: (s: string) => string
    stripCorp: (s: string) => string | null
    searchVariants: (s: string) => string[]
  }
}

const { toFullWidth, normalizeForSearch, stripCorp, searchVariants } = load()

describe('toFullWidth', () => {
  it('半角英数字と空白を全角にする', () => {
    // 実測: "GFD" は0件、"ＧＦＤ" で 派14-301189 が返る
    expect(toFullWidth('GFD')).toBe('ＧＦＤ')
    expect(toFullWidth('Kaizen Tech Agent')).toBe('Ｋａｉｚｅｎ　Ｔｅｃｈ　Ａｇｅｎｔ')
  })

  it('日本語はそのまま残す', () => {
    expect(toFullWidth('株式会社Ｐｈｏｅｎｉｘテクノロジーズ')).toBe('株式会社Ｐｈｏｅｎｉｘテクノロジーズ')
    expect(toFullWidth('株式会社さくらケーシーエス')).toBe('株式会社さくらケーシーエス')
  })
})

describe('normalizeForSearch', () => {
  it('機種依存の㈱を株式会社に開く', () => {
    // 実測: 「㈱KICOシステムズ」は0件、「株式会社ＫＩＣＯシステムズ」で一致
    expect(normalizeForSearch('㈱KICOシステムズ')).toBe('株式会社KICOシステムズ')
    expect(normalizeForSearch('㈲山田製作所')).toBe('有限会社山田製作所')
  })

  it('行頭の装飾記号を落とす', () => {
    // メール署名の罫線がそのまま社名に入っていた（prod 実害: ae-st.com）
    expect(normalizeForSearch('━━アエスト株式会社')).toBe('アエスト株式会社')
    expect(normalizeForSearch('■株式会社テスト')).toBe('株式会社テスト')
    expect(normalizeForSearch('  ・株式会社テスト ')).toBe('株式会社テスト')
  })

  it('末尾の罫線も落とす（prod 実害: wiz-tech.jp）', () => {
    expect(normalizeForSearch('株式会社WizTech━━━━━━━━━┓')).toBe('株式会社WizTech')
  })

  it('末尾の長音は社名の一部なので残す', () => {
    expect(normalizeForSearch('株式会社スカイツリー')).toBe('株式会社スカイツリー')
    expect(normalizeForSearch('株式会社ライトアーム')).toBe('株式会社ライトアーム')
  })

  it('社名の途中の記号は消さない', () => {
    expect(normalizeForSearch('株式会社アイ・ピー・コンサルタント')).toBe('株式会社アイ・ピー・コンサルタント')
    expect(normalizeForSearch('株式会社PLAN-B')).toBe('株式会社PLAN-B')
  })
})

describe('stripCorp', () => {
  it('前株・後株のどちらも外す', () => {
    expect(stripCorp('株式会社ディアリズム')).toBe('ディアリズム')
    expect(stripCorp('ライトアーム株式会社')).toBe('ライトアーム')
    expect(stripCorp('合同会社テスト')).toBe('テスト')
  })

  it('法人格が無ければ null', () => {
    expect(stripCorp('ディアリズム')).toBeNull()
  })
})

describe('searchVariants', () => {
  it('素 → 全角 → 法人格なし → 法人格なし全角 の順に返す', () => {
    expect(searchVariants('株式会社GFD')).toEqual([
      '株式会社GFD',
      '株式会社ＧＦＤ',
      'GFD',
      'ＧＦＤ',
    ])
  })

  it('法人格を外したキーは必ず後ろに置く（同名の別会社を先に拾わせない）', () => {
    const keys = searchVariants('株式会社MIT')
    expect(keys.indexOf('株式会社ＭＩＴ')).toBeLessThan(keys.indexOf('ＭＩＴ'))
  })

  it('全角にしても変わらない社名はキーを増やさない', () => {
    expect(searchVariants('株式会社さくらケーシーエス')).toEqual([
      '株式会社さくらケーシーエス',
      'さくらケーシーエス',
    ])
  })

  it('1文字の識別名は法人格なしキーにしない（検索がノイズだらけになる）', () => {
    expect(searchVariants('株式会社A')).toEqual(['株式会社A', '株式会社Ａ'])
  })

  it('空・記号だけなら1つも返さない', () => {
    expect(searchVariants('')).toEqual([])
    expect(searchVariants('━━')).toEqual([])
  })
})
