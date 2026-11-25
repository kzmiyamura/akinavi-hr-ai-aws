/**
 * 自社メールの引用除去（inbound-email の cutOwnDomainQuote）の回帰テスト（#187）。
 *
 * こちらが送った案件紹介への返信が人材として取り込まれ、引用された案件文が
 * 人材の本文として扱われていた（ローカル控えの全期間で10件）。
 * 手写しのレプリカを作らず index.ts から切り出して検証する（irrelevantMail.test.ts と同じ方式）。
 * 本文は実物の形だけ借りて、氏名・会社・連絡先は架空のものに置き換えてある。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadCut(): (body: string, own: string | null) => string {
  const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n')
  const m = src.match(/function cutOwnDomainQuote\(body: string, ownDomain: string \| null\): string \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('cutOwnDomainQuote を index.ts から取り出せませんでした')
  return new Function(`return function (body, ownDomain) {${m[1]}\n}`)() as (b: string, o: string | null) => string
}
const cut = loadCut()
const OWN = 'i-voice.co.jp'

// 11-11 の実物の形: 取引先の返信 → こちらの案件紹介の引用
const REPLY_TO_OUR_PROJECT = [
  '株式会社ボイス',
  '阿部様',
  '',
  'お世話になっております。',
  '株式会社サンプルの山田でございます。',
  '是非進めていただきたく存じます。',
  '並行状況は以下の通りでございます。',
  '・1/1面談　1件設定済み',
  '',
  '2026年11月11日(水) 14:09 <ikumi@i-voice.co.jp>:',
  '',
  '株式会社サンプル',
  '山田　様',
  '株式会社ボイス営業部の阿部です。',
  'Cobol保守案件',
  '勤務地：東品川（最寄駅：品川シーサイド）',
  '概　要：銀行の情報系システム（IBMホスト）、DB2、JCL',
].join('\n')

describe('自社メールの引用より下を切る', () => {
  it('Gmail（日本語）の引用ヘッダから下を切り、取引先の文は残す', () => {
    const out = cut(REPLY_TO_OUR_PROJECT, OWN)
    expect(out).toContain('1/1面談')
    expect(out).not.toContain('Cobol保守案件')
    expect(out).not.toContain('DB2')
  })
  it('改行が CRLF の本文でも切る（Outlook 経由の本文は CRLF のまま来る）', () => {
    const out = cut(REPLY_TO_OUR_PROJECT.replace(/\n/g, '\r\n'), OWN)
    expect(out).toContain('1/1面談')
    expect(out).not.toContain('Cobol保守案件')
  })
  it('似たドメインの「差出人:」行では切らない', () => {
    const body = '紹介です。\n\n差出人: x <a@i-voice.co.jp.example.com>\n本文'
    expect(cut(body, OWN)).toBe(body)
  })
  it('ヘッダが名前のあとで2行に折り返していても切る', () => {
    const body = 'ご提案です。\n氏名: T.K\n\n2026年11月18日(水) 15:04 阿部 優\n<ikumi@i-voice.co.jp>:\n\n以下案件で募集あります。Java'
    const out = cut(body, OWN)
    expect(out).toContain('氏名: T.K')
    expect(out).not.toContain('募集あります')
  })
  it('返信の上に新しい人の紹介があれば、その紹介は全部残る（11-24 の形）', () => {
    const body = [
      'ご連絡ありがとうございます。下記要員いかがでしょうか。',
      '【氏名】H.W（35歳・男性）',
      '【最寄】大井町駅',
      '【スキル】Java 8年、Spring Boot',
      '【単価】70万円',
      '',
      '2026年11月18日(水) 15:04 <ikumi@i-voice.co.jp>:',
      '以下案件で募集あります。COBOL / 品川',
    ].join('\n')
    const out = cut(body, OWN)
    expect(out).toContain('【スキル】Java 8年、Spring Boot')
    expect(out).toContain('【単価】70万円')
    expect(out).not.toContain('COBOL')
  })
  it('英語の Gmail「On … wrote:」も切る', () => {
    const body = 'Please see below.\nName: A.B\n\nOn Wed, Nov 11, 2026 at 2:09 PM Abe <ikumi@i-voice.co.jp> wrote:\n> COBOL project'
    expect(cut(body, OWN)).toBe('Please see below.\nName: A.B')
  })
  it('Outlook の「差出人:」行に自社アドレスがあれば切る', () => {
    const body = '承知しました。\n\n差出人: 阿部 <ikumi@i-voice.co.jp>\n送信日時: 2026年11月19日\n件名: 案件のご相談（株式会社ボイス）\nJava案件です'
    expect(cut(body, OWN)).toBe('承知しました。')
  })
  it('「>」で引用された塊に自社アドレスがあれば、その塊から下を切る', () => {
    const body = '見送り承知しました。\n\n> 株式会社ボイス営業部の阿部です。\n> どちらも見送りでお願いします。\n> ikumi@i-voice.co.jp\n'
    expect(cut(body, OWN)).toBe('見送り承知しました。')
  })
  it('手前にある他社の「>」引用は切らず、自社の塊から切る', () => {
    const body = '以下の人材です。\n> 【氏名】K.S 30歳\n> Java 5年\n\n補足です。\n> 株式会社ボイス 阿部\n> ikumi@i-voice.co.jp'
    const out = cut(body, OWN)
    expect(out).toContain('> Java 5年')
    expect(out).toContain('補足です。')
    expect(out).not.toContain('ikumi@')
  })
})

describe('切らない（今までと同じ）', () => {
  it('他社どうしの引用は触らない', () => {
    const body = '転送します。\n\n2026年11月11日(水) 14:09 <sales@example.co.jp>:\n【氏名】A.B\nJava 5年'
    expect(cut(body, OWN)).toBe(body)
  })
  it('先頭がいきなり自社の引用なら切らない（上に何も残らないため）', () => {
    const body = '2026年11月11日(水) 14:09 <ikumi@i-voice.co.jp>:\n本文'
    expect(cut(body, OWN)).toBe(body)
  })
  it('自社ドメインが取れていなければ何もしない', () => {
    expect(cut(REPLY_TO_OUR_PROJECT, null)).toBe(REPLY_TO_OUR_PROJECT)
    expect(cut(REPLY_TO_OUR_PROJECT, '')).toBe(REPLY_TO_OUR_PROJECT)
  })
  it('本文中に自社アドレスが書いてあるだけ（引用ヘッダではない）なら切らない', () => {
    const body = '株式会社ボイス 御中\nご担当者様（ikumi@i-voice.co.jp）\n【氏名】A.B\nJava 5年'
    expect(cut(body, OWN)).toBe(body)
  })
  it('似たドメイン（i-voice.co.jp.example.com）では切らない', () => {
    const body = '紹介です。\n\n2026年11月11日(水) 14:09 <a@i-voice.co.jp.example.com>:\n本文'
    expect(cut(body, OWN)).toBe(body)
  })
})
