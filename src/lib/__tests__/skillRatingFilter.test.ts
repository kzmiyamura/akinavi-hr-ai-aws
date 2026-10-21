/**
 * 評価欄つきスキルシートの絞り込み（`inbound-email` の `filterBySkillRating`）のテスト。
 *
 * 出回っている雛形は言語名が印刷済みで、横の評価欄に A〜E を書き込む。
 * 「同じ行に A/B/C があるスキルだけ残す」ことで、印刷されているだけのスキルを落とす。
 *
 * ⚠ 2026-10-21 まで **C 言語だけが必ず残っていた**。スキル名の「C」そのものを
 *   評価の C と読んでいたため。控えの実測（2026-09-18 以降）で、C を持つ人のうち
 *   本文にも C言語 にも根拠が無く、経歴書の C が雛形の印刷だった人が多数いた
 *   （同じ雛形の Rust・Ruby は正しく落ちている）。
 *
 * 正は `supabase/functions/inbound-email/index.ts`。ここで読むのは
 * `node scripts/sync_extractors.mjs` の生成物なので、index.ts を直したら再生成すること。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error 型定義のない生成物（実行は vitest のみ）
import { filterBySkillRating } from '../../../scripts/_extractors.gen.mjs'

const names = (text: string, skills: string[]) =>
  (filterBySkillRating(text, skills.map((name) => ({ name, category: 'languages' }))) as { name: string }[])
    .map((s) => s.name)

// gridToFieldText の出力の形（3セル以上の行は1セル1行になる）。控えに実在した雛形の行:
//   要件定義 | B | Bash | Ruby / 基本設計 | B | C | Rust / 詳細設計 | A | C# | Scala
const TEMPLATE = [
  '保有技術', '業務範囲', 'その他言語',
  '要件定義', 'B', 'Bash', 'Ruby',
  '基本設計', 'B', 'C', 'Rust',
  '詳細設計', 'A', 'C#', 'Scala',
  '製造・実装', 'A', 'C++', 'Shell',
  '単体テスト', 'B', 'COBOL', 'SQL',
].join('\n')

describe('評価欄つきの雛形', () => {
  it('印刷されているだけの C は落とす（スキル名の C を評価と読まない）', () => {
    expect(names(TEMPLATE, ['C', 'Rust', 'Ruby'])).toEqual([])
  })

  it('C に評価が付いている行は残す', () => {
    expect(names(`${TEMPLATE}\nC,3,B`, ['C'])).toEqual(['C'])
    expect(names(`${TEMPLATE}\nC\tA`, ['C'])).toEqual(['C'])
  })

  it('C の評価が D/E なら落とす', () => {
    expect(names(`${TEMPLATE}\nC,1,D`, ['C'])).toEqual([])
  })

  it('他のスキルの判定は変わらない', () => {
    expect(names(`${TEMPLATE}\nJava,5,A`, ['Java', 'Rust'])).toEqual(['Java'])
  })
})

/**
 * gridToFieldText は3セル以上の行を1セル1行にするので、評価は**次の行**に来る。
 * 同じ行だけを見ていた頃は、評価の付いたスキルも雛形の中では全部落ちていた。
 */
describe('評価が次の行にある', () => {
  // 控えに実在した行: 要件定義 | B | Bash | C | Ruby（Bash の評価が C）/ C言語 | A
  const ROW = `${TEMPLATE}\n要件定義\nB\nBash\nC\nRuby\nC言語\nA`

  it('次の行が A/B/C なら残す', () => {
    expect(names(ROW, ['Bash', 'Ruby'])).toEqual(['Bash'])
  })

  it('C言語 の次の行が A なら C は残す', () => {
    expect(names(ROW, ['C'])).toEqual(['C'])
  })

  it('評価の C の次の行は C 言語の評価ではない', () => {
    // 行「C」は Bash の評価。次の行は Ruby なので C 言語としては残さない
    expect(names(`${TEMPLATE}\n要件定義\nB\nBash\nC\nRuby`, ['C'])).toEqual([])
  })

  it('年数のセルを1つ挟んだ評価も読む（c/c++ | 15年以上 | 【A】業務の独力遂行）', () => {
    expect(names(`${TEMPLATE}\nc/c++\n15年以上\n【A】業務の独力遂行`, ['C'])).toEqual(['C'])
  })

  it('長い文の次の行は評価と読まない', () => {
    expect(names(`${TEMPLATE}\n業務経験は組込C及び車載開発で、制御ソフトの設計から試験まで担当しました\nA`, ['C'])).toEqual([])
  })
})

describe('評価欄の無い経歴書', () => {
  it('評価の行が5行未満なら何も落とさない（プロジェクト表の C は残す）', () => {
    const text = ['作業期間', '1998/8', '携帯電話組み込みモジュール開発', 'UNIX', 'C', '1'].join('\n')
    expect(names(text, ['C', 'UNIX'])).toEqual(['C', 'UNIX'])
  })
})
