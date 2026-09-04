/**
 * 名簿メールの参照リンクの有効期限判定。
 *
 * 実体は poll-email が raw/ に保存したものをそのまま指しており（コピーを作らない）、
 * raw/ の保持は1日なので、翌日以降はリンク切れになる。押して壊れたページが出るより、
 * 「保持期間を過ぎた」と画面で説明するほうが親切なのでこの判定を使う。
 */
import { describe, it, expect } from 'vitest'
import { isRosterLinkAlive, RAW_ATTACHMENT_RETENTION_DAYS } from '../viewerUrl'

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

describe('isRosterLinkAlive', () => {
  it('保持日数は cleanup-storage の raw_retention_days と揃える', () => {
    expect(RAW_ATTACHMENT_RETENTION_DAYS).toBe(1)
  })

  it('登録直後は有効', () => {
    expect(isRosterLinkAlive(new Date().toISOString())).toBe(true)
  })

  it('1時間前は有効', () => {
    expect(isRosterLinkAlive(hoursAgo(1))).toBe(true)
  })

  it('23時間前はまだ有効', () => {
    expect(isRosterLinkAlive(hoursAgo(23))).toBe(true)
  })

  it('25時間前は期限切れ', () => {
    expect(isRosterLinkAlive(hoursAgo(25))).toBe(false)
  })

  it('1週間前は期限切れ', () => {
    expect(isRosterLinkAlive(hoursAgo(24 * 7))).toBe(false)
  })

  it('日時が無い場合は期限切れ扱い（リンクを出さない）', () => {
    expect(isRosterLinkAlive(null)).toBe(false)
    expect(isRosterLinkAlive(undefined)).toBe(false)
    expect(isRosterLinkAlive('')).toBe(false)
  })

  it('壊れた日時は期限切れ扱い', () => {
    expect(isRosterLinkAlive('not-a-date')).toBe(false)
  })
})
