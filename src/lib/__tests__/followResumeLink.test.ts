/**
 * 短縮URL・配信サービスの追跡URLを辿ってよいかの判断（`shouldFollowResumeLink`）。
 *
 * ■ なぜ辿るのか（2026-09-23 実測・直近7日 7,862通）
 *   「経歴書の文脈」のURL 2,920件のうち **1,079件(37%) が未対応ドメイン**だった。
 *   最大は bit.ly 365件、次いで配信サービスのクリック追跡。
 *   未対応URLを39件辿ったところ **34件(87%) が docs/drive.google.com に着いた**。
 *     bit.ly → docs.google.com ／ f.bmb.jp → drive.google.com
 *     cuenote・awstrack のクリック追跡 → docs.google.com
 *
 * ■ ここが一番危ない場所
 *   配信サービスの追跡ドメインでは、**経歴書リンクと配信停止リンクが同じドメインに同居する**。
 *   URLの形だけでは見分けられない。間違えて踏むと
 *   **取引先からのメールが止まり、人材の流入そのものが消える**。
 *   だから URL と周辺文言の両方を見て、迷ったら辿らない側に倒す。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error — index.ts から自動生成した JS（型定義なし）
import { shouldFollowResumeLink } from '../../../scripts/_extractors.gen.mjs'

const ok = (url: string, around: string): boolean =>
  shouldFollowResumeLink(url, around) as boolean

describe('辿ってよいURL', () => {
  it('経歴書の文脈にある短縮URLは辿る', () => {
    expect(ok('https://bit.ly/4gs6WSU',
      '●スキルシート：https://bit.ly/4gs6WSU リンク内よりダウンロードいただけます。')).toBe(true)
  })

  it('配信サービスのクリック追跡URLも辿る', () => {
    expect(ok('https://gy53-cl.asp.cuenote.jp/c/X9Vabc',
      '【経歴書】https://gy53-cl.asp.cuenote.jp/c/X9Vabc をご確認ください')).toBe(true)
    expect(ok('https://f.bmb.jp/8/5401/8831/2797',
      'レジュメはこちら https://f.bmb.jp/8/5401/8831/2797')).toBe(true)
  })

  it('「要員情報」「人材情報」も経歴書の手がかりとして扱う', () => {
    expect(ok('https://x.gd/abc123', '要員情報: https://x.gd/abc123')).toBe(true)
  })
})

describe('絶対に辿ってはいけないURL', () => {
  it('配信停止リンクは辿らない（踏むと取引先からのメールが止まる）', () => {
    expect(ok('https://gy53-cl.asp.cuenote.jp/c/unsubscribe?id=1',
      'スキルシートの配信停止はこちら https://gy53-cl.asp.cuenote.jp/c/unsubscribe?id=1')).toBe(false)
  })

  it('URLが無害に見えても、周辺が配信停止なら辿らない', () => {
    // 追跡ドメインは経歴書リンクと配信停止リンクが同居する。URLの形では見分けられない
    expect(ok('https://f.bmb.jp/8/5401/9999/2797',
      '経歴書の配信を停止する場合はこちら https://f.bmb.jp/8/5401/9999/2797')).toBe(false)
    expect(ok('https://x.gd/zzz', 'スキルシート配信の購読解除は https://x.gd/zzz')).toBe(false)
  })

  it('承認・削除・退会など副作用のある語を含むURLは辿らない', () => {
    for (const u of [
      'https://bit.ly/approve-xyz',
      'https://ex.jp/confirm?token=1',
      'https://ex.jp/delete/123',
      'https://ex.jp/opt-out',
      'https://ex.jp/optout',
      'https://ex.jp/cancel',
      'https://ex.jp/退会',
    ]) {
      expect(ok(u, `スキルシート ${u}`), u).toBe(false)
    }
  })
})

describe('辿る必要がないURL', () => {
  it('経歴書の手がかりが無いURLは辿らない（本文中の全URLを踏みに行かない）', () => {
    expect(ok('https://bit.ly/abc', '弊社HPはこちら https://bit.ly/abc')).toBe(false)
    expect(ok('https://techlab-inc.co.jp/', 'HP：https://techlab-inc.co.jp/')).toBe(false)
  })

  it('LINE・SNSは経歴書の文脈に並んでいても辿らない', () => {
    // 営業の署名では公式LINEが経歴書リンクのすぐ近くに置かれるため文脈判定をすり抜ける。
    // 実測（控え7日）で line.me だけ249件拾い、1通3件までの枠を食い潰していた
    expect(ok('https://line.me/R/ti/p/@001szlar',
      'スキルシートはこちら／公式LINE https://line.me/R/ti/p/@001szlar')).toBe(false)
    expect(ok('https://lin.ee/abcd', '経歴書 https://lin.ee/abcd')).toBe(false)
    expect(ok('https://x.com/foo', 'スキルシート https://x.com/foo')).toBe(false)
    expect(ok('https://www.youtube.com/watch?v=1', '経歴書 https://www.youtube.com/watch?v=1')).toBe(false)
  })

  it('既に Google のリンクなら辿らない（既存経路が拾う）', () => {
    expect(ok('https://docs.google.com/spreadsheets/d/1abc/edit',
      '【スキルシート】https://docs.google.com/spreadsheets/d/1abc/edit')).toBe(false)
    expect(ok('https://drive.google.com/file/d/1abc/view',
      '経歴書 https://drive.google.com/file/d/1abc/view')).toBe(false)
  })

  it('空のURL・空の文脈では辿らない', () => {
    expect(ok('', 'スキルシート')).toBe(false)
    expect(ok('https://bit.ly/abc', '')).toBe(false)
  })
})
