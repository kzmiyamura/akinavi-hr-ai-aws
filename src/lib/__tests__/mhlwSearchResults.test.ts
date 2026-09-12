/**
 * 厚労省サイトの検索結果の読み取り（parseSearchResults / isSameCompany）の回帰テスト。
 *
 * 旧実装は許可番号と事業主名を別々に集めていたため、複数ヒットしたときに
 * 「どの会社の番号か」が失われ、部分一致で釣れた別会社の番号を貼っていた。実測:
 *   「株式会社ストリーク」→「エクストリーク株式会社」（派13-040467）
 *   「NHK」            →「株式会社ＮＨＫビジネスクリエイト」（派13-304310）
 *   「株式会社中小企業」  →「協同組合中小企業経営技術研究会」（派25-300406）
 * 他社の許可番号を貼るのは「免許なし」より悪いので、ここは必ず固定する。
 *
 * 固定データは実際の検索結果（「ケーシーエス」で全国検索・2026-09-12取得）。
 * レプリカは作らず、**本番に出す index.ts から関数を切り出して**検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/verify-agent-license/index.ts')
const FIXTURE = resolve(__dirname, 'fixtures/mhlw_search_kcs.html')

type Entry = { number: string; name: string; detailUrl: string | null }

function load() {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name: string) => {
    const m = src.match(new RegExp(`export function ${name}\\(([\\s\\S]*?)\\n\\}`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return `function ${name}(${m[1]}\n}`
      .replace(/: \{ number: string; name: string; detailUrl: string \| null \}\[\]/g, '')
      .replace(/: \{ at: number; kind: string; value: string \}\[\]/g, '')
      .replace(/: string \| null/g, '')
      .replace(/: string/g, '')
      .replace(/: boolean/g, '')
      .replace(/new Set<string>\(\)/g, 'new Set()')
  }
  const code = `
    ${pick('parseSearchResults')}
    ${pick('normalizeForSearch')}
    ${pick('companyKey')}
    ${pick('isSameCompany')}
    return { parseSearchResults, companyKey, isSameCompany }
  `
  return new Function(code)() as {
    parseSearchResults: (html: string) => Entry[]
    companyKey: (s: string) => string
    isSameCompany: (official: string, ours: string) => boolean
  }
}

const { parseSearchResults, companyKey, isSameCompany } = load()
const entries = parseSearchResults(readFileSync(FIXTURE, 'utf8'))

describe('parseSearchResults: 実際の検索結果を1件ずつに分解する', () => {
  it('番号と事業主名が行ごとに対応している', () => {
    const pairs = entries.map((e) => `${e.number} ${e.name}`)
    expect(pairs).toEqual([
      '派08-300274 株式会社ケーシーエス',
      '派08-300364 株式会社ケーシーエスエンジニアリング',
      '派12-301432 株式会社ケーシーエス',
      '派26-300623 株式会社ケーシーエス',
      '派27-303413 株式会社ケーシーエス・エス',
      '派28-302228 株式会社さくらケーシーエス',
      '派34-300525 株式会社　ケーシーエス',
    ])
  })

  it('同じ行がレイアウト違いで2度出ても1件に畳む', () => {
    const keys = entries.map((e) => `${e.number}|${e.name}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('詳細ページのリンクはその行の番号のもの（隣の行のリンクを貼らない）', () => {
    // href の detkey_Detail は「派28-302228」をURLエンコードした値
    const sakura = entries.find((e) => e.number === '派28-302228')
    expect(sakura?.detailUrl).toContain('detkey_Detail=')
    expect(decodeURIComponent(sakura?.detailUrl ?? '')).toContain('派28-302228')
    // 先頭行と混ざっていないこと
    expect(decodeURIComponent(sakura?.detailUrl ?? '')).not.toContain('派08-300274')
  })

  it('結果が無い HTML では1件も返さない', () => {
    expect(parseSearchResults('<html><body>検索結果に表示されない場合</body></html>')).toEqual([])
  })
})

describe('isSameCompany: 部分一致で釣れた別会社を採らない', () => {
  it('同じ会社なら表記が違っても true', () => {
    expect(isSameCompany('株式会社ＧＦＤ', '株式会社GFD')).toBe(true)
    expect(isSameCompany('株式会社ＫＩＣＯシステムズ', '㈱KICOシステムズ')).toBe(true)
    expect(isSameCompany('株式会社Ｋａｉｚｅｎ　Ｔｅｃｈ　Ａｇｅｎｔ', '株式会社Kaizen Tech Agent')).toBe(true)
    expect(isSameCompany('ＣＳエコー株式会社', 'CSエコー株式会社')).toBe(true)
    expect(isSameCompany('株式会社　ケーシーエス', '株式会社ケーシーエス')).toBe(true)
  })

  it('前株・後株の違いは同じ会社とみなす', () => {
    expect(isSameCompany('株式会社ストリーク', 'ストリーク株式会社')).toBe(true)
  })

  it('名前が含まれているだけの別会社は false（実際に貼られていた3件）', () => {
    expect(isSameCompany('エクストリーク株式会社', '株式会社ストリーク')).toBe(false)
    expect(isSameCompany('株式会社ＮＨＫビジネスクリエイト', 'NHK')).toBe(false)
    expect(isSameCompany('協同組合中小企業経営技術研究会', '株式会社中小企業')).toBe(false)
    expect(isSameCompany('株式会社ケーシーエスエンジニアリング', '株式会社ケーシーエス')).toBe(false)
  })

  it('検索結果から自社の行だけを選べる', () => {
    const mine = entries.filter((e) => isSameCompany(e.name, '株式会社さくらケーシーエス'))
    expect(mine.map((e) => e.number)).toEqual(['派28-302228'])
  })

  it('1文字に縮む名前では一致させない', () => {
    expect(isSameCompany('株式会社', '株式会社')).toBe(false)
  })
})

describe('companyKey', () => {
  it('表示用ではないので画面には使わない（記号と法人格が落ちる）', () => {
    expect(companyKey('株式会社アイ・ピー・コンサルタント')).toBe('アイピーコンサルタント')
  })
})
