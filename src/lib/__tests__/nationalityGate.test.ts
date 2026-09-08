/**
 * 国籍の妥当性判定（inbound-email の isValidNationality）の回帰テスト。
 *
 * prod 実測（2026-09-09）で国籍を持つ約450人のうち38件が国籍でない値だった。
 * 「籍で終われば通す」判定が、経歴書の業務内容にある「電子書籍」(24)・「多国籍」(12)・
 * 「現在も在籍」を通していた。NGワード列挙では複合語をすり抜けるので、国名を要求する形に反転した。
 *
 * レプリカは作らず、**本番に出す index.ts から関数を切り出して**検証する
 * （stationGate.test.ts / companyName.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadGate(): (v: string) => boolean {
  const src = readFileSync(SRC, 'utf8')

  const names = src.match(/const NATIONALITY_NAMES = \[([\s\S]*?)\n\]/)
  if (!names) throw new Error('NATIONALITY_NAMES を index.ts から取り出せませんでした')

  const fn = src.match(/function isValidNationality\(([\s\S]*?)\n\}/)
  if (!fn) throw new Error('isValidNationality を index.ts から取り出せませんでした')

  const code = `
    const NATIONALITY_NAMES = [${names[1]}]
    ${`function isValidNationality(${fn[1]}\n}`
      .replace(/: string/g, '')
      .replace(/: boolean/g, '')}
    return isValidNationality
  `
  return new Function(code)() as (v: string) => boolean
}

const ok = loadGate()

describe('isValidNationality', () => {
  it('経歴の業務内容を国籍として採らない（prod 実データ由来）', () => {
    for (const ng of ['電子書籍', '大手電子書籍', '某大手書籍', '大学図書館向け海外書籍',
                      '関連書籍', '多国籍', '現在も在籍', '要員HKの国籍']) {
      expect(ok(ng), ng).toBe(false)
    }
  })

  it('見出し語・営業文の断片を採らない', () => {
    for (const ng of ['国籍', '本籍', '戸籍', '移籍', '入籍', '学籍', '在籍',
                      '上記人', '全国', '1人', '性別', '氏名']) {
      expect(ok(ng), ng).toBe(false)
    }
  })

  it('国名は通す', () => {
    for (const good of ['日本', '中国', '中国籍', '日本籍', '日本国籍', '日本人',
                        '韓国籍', 'ベトナム国籍', 'ロシア', 'マレーシア', 'インド人',
                        'メキシコ籍', '台湾国籍', 'ナイジェリア籍']) {
      expect(ok(good), good).toBe(true)
    }
  })

  it('国名を伏せた表記も通す', () => {
    for (const good of ['外国籍', '海外籍', '日系外国籍']) {
      expect(ok(good), good).toBe(true)
    }
  })

  it('括弧・※以降の補足を落として判定する', () => {
    for (const good of ['フィリピン（就労ビザ）', 'ブラジル(永住権取得済み)',
                        '中国籍（ビザ期限', '中国（永住権取得済み）', 'インド※日本語流暢',
                        '中国（日本語：ネイティブ／日本']) {
      expect(ok(good), good).toBe(true)
    }
  })

  it('前置きの記号・性別を落として判定する', () => {
    for (const good of ['：中国', '男性・日本籍', '男性/日本人']) {
      expect(ok(good), good).toBe(true)
    }
  })

  it('補足付きの正当な表記を落とさない', () => {
    for (const good of ['元中国籍', '日本生まれ日本国籍', '日本在住', '日本（中国と日本のハーフ）']) {
      expect(ok(good), good).toBe(true)
    }
  })

  it('空・長すぎ・数字入りは採らない', () => {
    for (const ng of ['', '   ', '日本人材を3名ご紹介いたします', '2人']) {
      expect(ok(ng), JSON.stringify(ng)).toBe(false)
    }
  })
})
