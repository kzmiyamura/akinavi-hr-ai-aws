/**
 * skill_master 照合の語境界（`inbound-email` の `skillTermPattern`）のテスト。
 *
 * ここが当たらないと **`skills` 列にスキルが1つも入らない**。
 * 人材は一覧の優先スキル絞り込みから丸ごと消えるので、営業から見れば存在しない人になる。
 *
 * 正は `supabase/functions/inbound-email/index.ts`。
 * ここで読んでいるのは `node scripts/sync_extractors.mjs` が生成した複製なので、
 * **index.ts を直したら再生成すること**（生成が古いとこのテストは嘘をつく）。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error 型定義のない生成物（実行は vitest のみ）
import { skillTermPattern } from '../../../scripts/_extractors.gen.mjs'

const hit = (term: string, text: string) => new RegExp(skillTermPattern(term), 'i').test(text)

describe('スペースの代わりに `_` を使う本文', () => {
  /**
   * 控えの実測（2026-10-04）に実在した本文。この送信元は全ての区切りが `_`:
   *   【氏 名】H.K(32歳_男性) 常駐可 … 【スキル】Java_5年8ヶ月 【単 価】60万円
   * `_` を語の一部として扱っていたため Java が取れず、同じメールのもう1人は
   * **skills 列が空**だった。
   */
  it('`_` + 数字は区切りとして扱う', () => {
    expect(hit('Java', '【スキル】Java_5年8ヶ月 【単 価】60万円')).toBe(true)
    expect(hit('Python', 'Python_2年')).toBe(true)
  })

  it('`_` + 日本語も区切り', () => {
    expect(hit('Java', 'Java_経験あり')).toBe(true)
  })

  it('`_` で終わっていても当てる', () => {
    expect(hit('Java', 'Java_')).toBe(true)
  })

  it('識別子（`_` + 英字）はスキル名として扱わない', () => {
    // 環境変数・設定キーの名前。これを拾うと「Java 経験者」が量産される
    expect(hit('Java', 'JAVA_HOME を設定')).toBe(false)
    expect(hit('PHP', 'PHP_INI_SCAN_DIR')).toBe(false)
    expect(hit('Java', 'java_home')).toBe(false)
  })
})

describe('もとからある語境界（壊していないこと）', () => {
  it('前が英数字ならスキルではない', () => {
    expect(hit('Java', 'XJava')).toBe(false)
    expect(hit('C', 'VBC')).toBe(false)
  })

  it('後ろが英数字・ドットならスキルではない', () => {
    expect(hit('Java', 'JavaScript')).toBe(false)
    expect(hit('Java', 'Java2EE')).toBe(false)
    // 後ろのドットは従来どおり除外（`java.util` のようなパッケージ名を拾わない）
    expect(hit('Java', 'java.util.List')).toBe(false)
  })

  it('ふつうの記載は当たる', () => {
    expect(hit('Java', '【スキル】Java、C＃、Cobol')).toBe(true)
    expect(hit('Java', 'Java / Spring Boot')).toBe(true)
    expect(hit('C#', 'C#, VB.net')).toBe(true)
  })

  it('2〜3文字の英小文字は直後が日本語・空白・文末のときだけ', () => {
    expect(hit('go', 'go 言語')).toBe(true)
    expect(hit('go', 'go言語')).toBe(true)
    // 英単語の途中では拾わない
    expect(hit('go', 'golang に移行')).toBe(false)
    expect(hit('go', 'mongodb')).toBe(false)
  })

  it('⚠ 空白が続く英語の自然文は今も拾ってしまう（既知の弱さ・未修正）', () => {
    // 条件が「直後が日本語・空白・文末」なので、英文の "go to" も通る。
    // ここを締めるなら前後の文脈（スキル見出しの中か）を見る必要があり、別の話。
    // **直したつもりにならないよう、現状を固定しておく。**
    expect(hit('go', 'please go to the page')).toBe(true)
  })
})
