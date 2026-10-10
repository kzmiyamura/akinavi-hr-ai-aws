import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CANDIDATE_LINK_PARAM,
  candidateLinkUrl,
  formatCandidateNo,
  parseCandidateLinkParam,
} from '../candidateCode'

/**
 * 通知メールのリンク（`?c=<uuid>` / `?c=AK-000123`）。2026-10-10
 *
 * 営業から「メール通知で通知された人材からアプリで開きにくい」と指摘されて入れた。
 * メールには氏名と最寄駅しか無く、受け取った側は人材タブの絞り込みに氏名を
 * 打ち直していたが、イニシャル氏名は prod 実測で同名10件超が52種・最大35件あるので
 * **打ち直しても本人に辿り着けない**ことがあった。
 *
 * 規則は2か所にある（フロント＝このファイルが縛る `src/lib/candidateCode.ts` と、
 * メールを組む `supabase/functions/notify-candidates/index.ts`）。
 * Edge Function は Deno で src/ を import できないため、下の parity テストで
 * **ソースをテキストとして読んで**接頭辞・桁・クエリ名のズレを検出する。
 */
describe('parseCandidateLinkParam', () => {
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'

  it('uuid はその行を指す', () => {
    expect(parseCandidateLinkParam(UUID)).toEqual({ kind: 'id', id: UUID })
  })

  it('大文字の uuid も受ける（小文字に寄せる）', () => {
    expect(parseCandidateLinkParam(UUID.toUpperCase())).toEqual({ kind: 'id', id: UUID })
  })

  it('人材番号も受ける（口頭・チャットで番号だけ共有されたとき）', () => {
    expect(parseCandidateLinkParam('AK-002640')).toEqual({ kind: 'no', no: 2640 })
    expect(parseCandidateLinkParam('2640')).toEqual({ kind: 'no', no: 2640 })
  })

  it('解釈できない値は null（＝黙って無視して人材タブを普通に開く）', () => {
    // メールソフトが末尾に記号を足して壊すことがある。詰まらせない方に倒す
    expect(parseCandidateLinkParam(`${UUID}.`)).toBeNull()
    expect(parseCandidateLinkParam('田中')).toBeNull()
    expect(parseCandidateLinkParam('')).toBeNull()
    expect(parseCandidateLinkParam(null)).toBeNull()
  })

  it('uuid の桁が足りないものを id と誤認しない', () => {
    expect(parseCandidateLinkParam('0f8fad5b-d9cb-469f-a165-7086772895')).toBeNull()
  })
})

describe('candidateLinkUrl', () => {
  it('末尾スラッシュの有無どちらでも同じ URL になる', () => {
    const a = candidateLinkUrl('https://example.com', 'AK-000123')
    const b = candidateLinkUrl('https://example.com/', 'AK-000123')
    expect(a).toBe(b)
    expect(a).toBe('https://example.com/?c=AK-000123')
  })

  it('往復できる（作った URL をそのまま解釈できる）', () => {
    const url = new URL(candidateLinkUrl('https://example.com', 'AK-002640'))
    expect(parseCandidateLinkParam(url.searchParams.get(CANDIDATE_LINK_PARAM)))
      .toEqual({ kind: 'no', no: 2640 })
  })
})

describe('notify-candidates とフロントの規則が同じ', () => {
  const SRC = readFileSync(
    resolve(__dirname, '../../../supabase/functions/notify-candidates/index.ts'),
    'utf8',
  )

  it('メール側も `?c=` を使う', () => {
    expect(CANDIDATE_LINK_PARAM).toBe('c')
    expect(SRC).toMatch(/\/\?c=\$\{encodeURIComponent\(id\)\}/)
  })

  it('番号の書式が一致する（接頭辞 AK・6桁ゼロ埋め）', () => {
    const m = SRC.match(/return `(AK)-\$\{String\(Math\.trunc\(Number\(no\)\)\)\.padStart\((\d+), '0'\)\}`/)
    expect(m, 'notify-candidates の formatCandidateNo が見つからない').not.toBeNull()
    const [, prefix, digits] = m!
    expect(formatCandidateNo(123)).toBe(`${prefix}-${'123'.padStart(Number(digits), '0')}`)
  })

  it('メール本文に人材番号とリンクが入る', () => {
    expect(SRC).toContain('開く: ${candidateLink(appBase, h.id)}')
    expect(SRC).toContain('formatCandidateNo(h.candidateNo)')
  })

  it('URL に氏名や連絡先を入れていない', () => {
    // 受信側のメールソフトやプロキシに URL ごと残るため、uuid と番号だけにする
    expect(SRC).not.toMatch(/candidateLink\([^)]*h\.(name|email)/)
  })
})
