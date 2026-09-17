/**
 * 1メール複数人材（本文に複数人が並ぶメール）で、raw_profile.text に
 * **その人のブロックだけ**が入ることの回帰テスト。
 *
 * 2026-09-17 まではメール全文を全ブロックに入れていた。34人のメールなら
 * 34人全員の raw_profile.text が同じ34人ぶんの全文になる。
 * prod 実測で複数人材ブロック 895人の text 合計が 11MB（単独は 2,327人で 6.9MB）。
 *
 * 容量だけの問題ではなく、読み手が全員これを「本人の本文」として使う:
 *   ・AI校正（shadow_worker）は trimBodyForLlm(text) の先頭6,000字を本人の本文として
 *     LLM に渡す → 全員が1人目の本文で校正される
 *   ・再解析（reprocess_*）は text を本文として投げ直し target_candidate_id を
 *     block[0] に強制適用する → 27人目を再解析したのに1人目の内容で上書きされる
 *   ・画面の経歴書リンクは text 内の最初の Drive URL を拾う → 冒頭の「全体一覧」に繋がる
 *
 * レプリカは作らず、本番に出す index.ts の該当箇所を読んで確かめる
 * （roleLabelParity.test.ts / nearestStationField.test.ts と同じ方式）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'), 'utf8')

/** 「消した理由」を書いたコメントに引っかからないよう、行コメントを落とした版 */
const CODE = SRC.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n')

/** 複数人材ブロックの raw_profile リテラル（multiCandidateBlock: true を含む方）を切り出す */
function multiRawProfile(): string {
  const marker = SRC.indexOf('multiCandidateBlock: true')
  expect(marker, 'multiCandidateBlock: true が index.ts に見つからない').toBeGreaterThan(0)
  const start = SRC.lastIndexOf('raw_profile: {', marker)
  expect(start, '複数人材ブロックの raw_profile が見つからない').toBeGreaterThan(0)
  return SRC.slice(start, marker)
}

describe('1メール複数人材: 保存する本文はブロックだけ', () => {
  it('raw_profile.text にブロック変数を入れている', () => {
    expect(multiRawProfile()).toMatch(/text:\s*stripEmbeddedAttach\(sanitizeForPgJson\(block\)\)/)
  })

  it('メール全文を丸ごと入れていない', () => {
    const rp = multiRawProfile()
    // effectiveBody / storedBodyText はメール1通ぶん全部。ブロックに入れてはいけない
    expect(rp).not.toMatch(/text:\s*(?:sanitizeForPgJson\()?(?:effectiveBody|storedBodyText)/)
  })

  it('全文を指す storedBodyText 変数そのものが残っていない', () => {
    // 消し忘れると「使っていないのに全文を作り続ける」状態に戻りやすい
    expect(SRC).not.toMatch(/const\s+storedBodyText\s*=/)
  })

  it('単独メール側も疑似添付テキストを本文から落としている', () => {
    // 落とさないと再解析のたびに同じ添付テキストが text に積み増される
    expect(SRC).toMatch(/text:\s*stripEmbeddedAttach\(effectiveBody\)/)
  })
})

describe('動かない分岐を残さない: rosterAttachments は削除済み', () => {
  it('inbound-email に rosterAttachments が無い', () => {
    // raw/ への保存を 2026-09-14 に廃止して以降 raw_paths は常に空で、
    // prod 実測でも rosterAttachments を持つ人材は0件だった
    expect(CODE).not.toMatch(/rosterAttachments/)
  })

  it('inbound-email が raw_paths を読んでいない', () => {
    expect(CODE).not.toMatch(/raw_paths/)
  })
})
