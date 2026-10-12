import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { COMMERCIAL_FLOW_OPTIONS, EMPLOYMENT_TYPE_OPTIONS } from '../db/notificationRules'

/**
 * 通知ルールの「商流」「雇用形態」の選択肢が、画面と Edge Function でズレていないか。
 *
 * 判定は `supabase/functions/notify-candidates/match.ts` が正だが、そちらは Deno で動くため
 * src/ を import できず、**同じ集合が2か所にある**。画面に無い値を判定側が持っていても
 * 誰も選べないだけだが、逆（画面にしか無い値）は**選べるのに一生マッチしない条件**になる。
 * 2026-08-21 に通知のスキル判定が部分一致のまま取り残され、`Java` が `JavaScript` を
 * 拾っていたのと同じ構造なので、文字列として読んで突き合わせる。
 */
const SRC = readFileSync(
  resolve(__dirname, '../../../supabase/functions/notify-candidates/match.ts'),
  'utf8',
)

function arrayLiteral(name: string): string[] {
  const m = SRC.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`))
  expect(m, `match.ts に ${name} が見つからない`).not.toBeNull()
  return m![1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s !== '')
}

describe('通知ルールの選択肢が画面と Edge Function で一致している', () => {
  it('雇用形態', () => {
    expect(arrayLiteral('EMPLOYMENT_TYPES')).toEqual([...EMPLOYMENT_TYPE_OPTIONS])
  })

  it('商流', () => {
    expect(arrayLiteral('COMMERCIAL_FLOWS')).toEqual([...COMMERCIAL_FLOW_OPTIONS])
  })

  it('商流の丸め（flowBucket）が選択肢だけを返す', () => {
    // 判定側が返す値は、必ず選択肢のどれか（または未取得の null）でなければならない。
    // ここが崩れると「選んだのに一生マッチしない」商流が生まれる
    const buckets = SRC.match(/return '([^']+)'/g) ?? []
    const returned = buckets
      .map((s) => s.replace(/return '|'/g, ''))
      .filter((s) => s === '自社' || s === '1社先' || s === '2社先以降' || /社先/.test(s))
    expect(returned.length, 'flowBucket の返り値が見つからない').toBeGreaterThan(0)
    for (const v of returned) {
      expect(COMMERCIAL_FLOW_OPTIONS as readonly string[]).toContain(v)
    }
  })

  it('雇用形態の選択肢が inbound-email の抽出値と揃っている', () => {
    // 抽出側が作らない値を選択肢に出すと、選べるのに誰も当たらない。
    // 逆に抽出側にしか無い値は「その他」として未取得と同じ扱いになる
    const extractor = readFileSync(
      resolve(__dirname, '../../../supabase/functions/inbound-email/index.ts'),
      'utf8',
    )
    for (const v of EMPLOYMENT_TYPE_OPTIONS) {
      expect(extractor, `inbound-email が「${v}」を作らない`).toContain(`employmentType = '${v}'`)
    }
  })
})
