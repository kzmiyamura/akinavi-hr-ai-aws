/**
 * メール本文からのスキル年数抽出（inbound-email の extractSkillYearsFromBodyText）。
 *
 * 実害（2026-09-22 ユーザー指摘・株式会社グラントホープ U.N）:
 * 本文に月数がはっきり書かれているのに、**「約」が付くものが全滅**していた。
 *
 *   言語：C#・C#.NET(約122ヶ月) / VB.NET(約79ヶ月) / Java(約35ヶ月) / PL/SQL(4ヶ月)
 *   OS：Windows(約199ヶ月) / Linux(約20ヶ月) / Android(4ヶ月)
 *
 * 「約」が無い PL/SQL・Android は取れていて、「約」付きの10件が1つも取れない。
 * 月数のみを拾うパターン（3b）が `約?` を許していなかったのが原因。
 * 経験19年のベテランが「Java 経験なし」に見える状態で、単価交渉にも案件マッチにも効く。
 *
 * あわせて、スキル名の先頭が切れる不具合も出ていた:
 *   「Salesforce Marketing Cloud」→「orce Marketing Cloud」
 *   「Windowsタブレット」→「タブレット」
 *
 * レプリカは作らず、本番に出す index.ts から関数を切り出して検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 切り出し元は **`scripts/_extractors.gen.mjs`**（index.ts から自動生成された JS）。
 * index.ts から直接切ると TypeScript の型注釈を剥がす必要があり、
 * 正規表現リテラルの中まで壊してしまう（実際に SyntaxError を出した）。
 * 生成ファイルは `node scripts/sync_extractors.mjs` で index.ts と同期される。
 */
const SRC = resolve(__dirname, '../../../scripts/_extractors.gen.mjs')

/** 関数本体を「括弧を数えて」切り出す。
 *  `\n}` を終端にすると、中に行頭 `}` があったり無かったりで壊れる。
 *  文字列・正規表現リテラル内の括弧は数えないよう、ざっくり除いてから数える。 */
function cutFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} を index.ts から取り出せませんでした`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`${name} の終端が見つかりませんでした`)
}

function loadExtractor(): (text: string) => Record<string, number> {
  const src = readFileSync(SRC, 'utf8')
  // この関数は仕上げに filterSkillYears（妥当性の足切り）を呼ぶ。一緒に切り出す
  const js = [
    cutFunction(src, 'filterSkillYears'),
    cutFunction(src, 'extractSkillYearsFromBodyText'),
    'return extractSkillYearsFromBodyText',
  ].join('\n')
  return new Function(js)() as (text: string) => Record<string, number>
}

const extract = loadExtractor()

/** 実メール（グラントホープ U.N・2026-09-22 受信）のスキル欄そのまま */
const REAL_BODY = `【スキル】
言語：C#・C#.NET(約122ヶ月) / VB.NET(約79ヶ月) / Java(約35ヶ月) / PL/SQL(4ヶ月) / PHP(5ヶ月) / batch(4ヶ月)
FW：Spring Boot(5ヶ月) / Seasar2(9ヶ月) / Windows Forms(約67ヶ月) / INTARFRM(約26ヶ月)
DB：Oracle・Oracle10g/11g/12c(約108ヶ月) / SQLServer・SQLServer2019(約62ヶ月) / PostgreSQL(約15ヶ月) / MySQL(6ヶ月) / SQLite(4ヶ月)
OS：Windows(約199ヶ月) / Linux(約20ヶ月) / Android(4ヶ月) / Windowsタブレット(5ヶ月)
インフラ：Salesforce Marketing Cloud(30ヶ月)
その他：Salesforce(30ヶ月) / UAT(30ヶ月) / オフショア開発(24ヶ月) / ソースレビュー(24ヶ月)`

describe('本文のスキル年数（ヶ月表記）', () => {
  const got = extract(REAL_BODY)

  it('「約」が付いていても月数を拾う', () => {
    // これが全滅していた。経験19年の人が「Java 経験なし」に見えていた
    expect(got['Java'], 'Java(約35ヶ月)').toBe(35)
    expect(got['VB.NET'], 'VB.NET(約79ヶ月)').toBe(79)
    expect(got['Windows'], 'Windows(約199ヶ月)').toBe(199)
    expect(got['PostgreSQL'], 'PostgreSQL(約15ヶ月)').toBe(15)
    expect(got['Linux'], 'Linux(約20ヶ月)').toBe(20)
  })

  it('「約」が無いものは今までどおり取れる（壊していない）', () => {
    expect(got['PL/SQL']).toBe(4)
    expect(got['PHP']).toBe(5)
    expect(got['Spring Boot']).toBe(5)
    expect(got['Seasar2']).toBe(9)
    expect(got['MySQL']).toBe(6)
    expect(got['Android']).toBe(4)
    expect(got['UAT']).toBe(30)
  })

  it('スキル名の先頭が切れない', () => {
    // 「Salesforce Marketing Cloud」が「orce Marketing Cloud」になっていた
    expect(Object.keys(got)).not.toContain('orce Marketing Cloud')
    expect(got['Salesforce Marketing Cloud']).toBe(30)
    // 「Windowsタブレット」が「タブレット」→ 直した直後は「ブレット」になっていた
    // （カナの直前だけを見ていなかったため、1文字ずれた位置から始まっていた）
    expect(Object.keys(got)).not.toContain('タブレット')
    expect(Object.keys(got)).not.toContain('ブレット')
    expect(got['Windowsタブレット']).toBe(5)
  })

  it('人として有り得ない月数は拾わない', () => {
    const r = extract('Java(500ヶ月) / COBOL(0ヶ月)')
    expect(r['Java']).toBeUndefined()   // 41年超
    expect(r['COBOL']).toBeUndefined()
  })

  it('年表記も従来どおり', () => {
    const r = extract('Python（3年） / AWS：5年')
    expect(r['Python']).toBe(36)
    expect(r['AWS']).toBe(60)
  })
})
