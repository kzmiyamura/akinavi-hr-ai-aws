/**
 * 無関係メールの判定（inbound-email の irrelevantMailReason）の回帰テスト。
 *
 * ⚠ この判定は**存在しなかった**。ファイル先頭のコメントだけが
 *    `INBOUND_RELEVANCE_CHECK: false で事前の無関係メール判定を無効化（既定は true）`
 *    と書いており、実装は無かった（2026-10-03 発覚）。
 *    そのため国税庁を騙るフィッシングが人材として登録されていた。
 *
 * 検閲と同じく、手写しのレプリカを作らず **index.ts から切り出して**検証する
 * （companyNameGate.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts')

function loadJudge(): (s: string, b: string, hasAtt: boolean) => string | null {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name: string) => {
    const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[gimsuy]*)\\r?\\n`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return m[1]
  }
  const strip = src.match(/function stripZeroWidth\(s: string\): string \{([\s\S]*?)\n\}/)
  const judge = src.match(/function irrelevantMailReason\(subject: string, body: string, hasAttachment: boolean\): string \| null \{([\s\S]*?)\n\}/)
  if (!strip || !judge) throw new Error('関数を index.ts から取り出せませんでした')
  const code = `
    const ZERO_WIDTH_RE = ${pick('ZERO_WIDTH_RE')};
    const MAIL_HR_SIGNAL_RE = ${pick('MAIL_HR_SIGNAL_RE')};
    function stripZeroWidth(s) {${strip[1]}\n}
    return function (subject, body, hasAttachment) {${judge[1]}\n}
  `
  return new Function(code)() as (s: string, b: string, hasAtt: boolean) => string | null
}

const judge = loadJudge()
const ok = (s: string, b: string, att = false) => expect(judge(s, b, att)).toBeNull()
const ng = (s: string, b: string, att = false) => expect(judge(s, b, att)).toBe('NO_HR_SIGNAL')

describe('人材メールは必ず通す（誤爆ゼロが最優先）', () => {
  it('ふつうの人材メール', () => {
    ok('【直人材】Javaエンジニアのご紹介', '氏名: A.B\n年齢: 32歳\n単価: 70万\nスキル: Java, Spring')
  })
  it('件名だけに人材語があっても通す', () => {
    ok('【GFD人材】インフラ/PMO', 'お世話になっております。よろしくお願いいたします。')
  })
  it('本文が空でも添付があれば通す（経歴書だけ付いたメール）', () => {
    ok('ご確認ください', 'お世話になっております。', true)
  })
  it('スキル欄の見出しだけでも通す', () => {
    ok('ご提案', '・言語：PHP\n・FW等：Laravel\n・DB：MySQL')
  })
  it('空文字は判定しない（EMPTY_BODY_AND_ATTACHMENTS の担当）', () => {
    ok('', '')
  })
})

describe('2026-10-03 に本番で人材として登録されていた無関係メール', () => {
  it('国税庁を騙るフィッシング（ゼロ幅文字で回避してくる）', () => {
    // ⚠ 実物は1文字おきにゼロ幅文字が入っていた。落とさないと語が一致しない
    const subject = '【 重 要 】還付金\u200Cに関す\u2060る確\u200D認のお知\u200Dら\u2060せが届いて\u200Dいま\u200Bす\u200B'
    const body = '国\uFEFF税\u2060庁\u200D からのお知らせです。メッセージボックスに未読があります。'
      + 'ログインのうえご確認をお願いします。配信の停止は利用者情報の登録画面から行えます。'
    ng(subject, body)
  })
  it('Amazon 偽装', () => {
    ng('【重要】Amazon Prime会費の引き落としに失敗', 'お支払い方法をご確認ください。')
  })
  it('広告・プレゼント', () => {
    ng('【重要なお知らせ】25周年記念プレゼントについて', 'ダイヤモンド会員の特典をご紹介します。')
  })
  it('セミナー案内', () => {
    ng('【TISIセミナー開催案内！】持続可能な取引関係構築のための説明会について', 'ご案内申し上げます。')
  })
  it('取引先アンケート', () => {
    ng('「ビジネスパートナー様満足度調査アンケート2026」へのご協力のお願い', 'ご協力をお願いいたします。')
  })
})

describe('ゼロ幅文字', () => {
  it('落とすと人材語が見える（＝正当なメールを誤って弾かない）', () => {
    ok('人\u200B材\u200Bのご紹介', '氏\uFEFF名: A.B')
  })
})
