/**
 * 派遣・紹介会社管理の並び替え。
 *
 * 223社を1画面では見られないので並び替えを入れた（2026-09-12 ユーザー要望）。
 * 上から順に潰していく作業に使うため、**同じ入力なら必ず同じ順序**になることと、
 * 「要確認を先に」の意味が崩れないことを固定する。
 */
import { describe, it, expect } from 'vitest'
import { sortAgentCompanies, sortMetaLabel, AGENT_SORT_OPTIONS } from '../agentCompanySort'
import type { AgentCompany, LicenseStatus } from '../db/agentCompanies'

function co(
  domain: string,
  opts: Partial<Pick<AgentCompany, 'company_name' | 'license_status' | 'first_seen_at' | 'verified_at'>> = {},
): AgentCompany {
  return {
    domain,
    // `?? domain` にすると company_name: null を渡せない（null が既定値に置き換わる）
    company_name: 'company_name' in opts ? opts.company_name ?? null : domain,
    haken_number: null,
    haken_detail_url: null,
    shokai_number: null,
    license_status: (opts.license_status ?? 'unknown') as LicenseStatus,
    verified_at: opts.verified_at ?? null,
    verified_by: null,
    source: 'email',
    memo: null,
    first_seen_at: opts.first_seen_at ?? '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

const names = (list: AgentCompany[]) => list.map((c) => c.domain)

describe('登録日順', () => {
  const list = [
    co('b.jp', { first_seen_at: '2026-06-10T00:00:00Z' }),
    co('a.jp', { first_seen_at: '2026-09-01T00:00:00Z' }),
    co('c.jp', { first_seen_at: '2026-07-20T00:00:00Z' }),
  ]

  it('新しい順', () => {
    expect(names(sortAgentCompanies(list, 'newest'))).toEqual(['a.jp', 'c.jp', 'b.jp'])
  })

  it('古い順', () => {
    expect(names(sortAgentCompanies(list, 'oldest'))).toEqual(['b.jp', 'c.jp', 'a.jp'])
  })

  it('元の配列を書き換えない', () => {
    const before = names(list)
    sortAgentCompanies(list, 'oldest')
    expect(names(list)).toEqual(before)
  })
})

describe('会社名順', () => {
  it('日本語を五十音で並べる', () => {
    const list = [
      co('c.jp', { company_name: '株式会社サクヤ' }),
      co('a.jp', { company_name: '株式会社あかつき' }),
      co('b.jp', { company_name: '株式会社かえで' }),
    ]
    expect(names(sortAgentCompanies(list, 'name'))).toEqual(['a.jp', 'b.jp', 'c.jp'])
  })

  it('会社名が無い行は最後（画面では「（会社名不明）」）', () => {
    const list = [
      co('x.jp', { company_name: null }),
      co('a.jp', { company_name: 'あ社' }),
    ]
    expect(names(sortAgentCompanies(list, 'name'))).toEqual(['a.jp', 'x.jp'])
  })
})

describe('要確認を先に', () => {
  it('照合できず → 未確認 → 紹介のみ → 免許なし → 派遣可 の順', () => {
    const list = [
      co('haken.jp', { license_status: 'haken' }),
      co('none.jp', { license_status: 'none' }),
      co('notfound.jp', { license_status: 'notfound' }),
      co('both.jp', { license_status: 'both' }),
      co('unknown.jp', { license_status: 'unknown' }),
      co('shokai.jp', { license_status: 'shokai' }),
    ]
    expect(names(sortAgentCompanies(list, 'status'))).toEqual([
      'notfound.jp', 'unknown.jp', 'shokai.jp', 'none.jp', 'haken.jp', 'both.jp',
    ])
  })

  it('「免許なし」は人が出した結論なので、結論が出ていない「照合できず」より後ろ', () => {
    const list = [co('none.jp', { license_status: 'none' }), co('nf.jp', { license_status: 'notfound' })]
    expect(names(sortAgentCompanies(list, 'status'))).toEqual(['nf.jp', 'none.jp'])
  })

  it('同じステータスの中は会社名順', () => {
    const list = [
      co('b.jp', { license_status: 'notfound', company_name: 'か社' }),
      co('a.jp', { license_status: 'notfound', company_name: 'あ社' }),
    ]
    expect(names(sortAgentCompanies(list, 'status'))).toEqual(['a.jp', 'b.jp'])
  })
})

describe('最終確認が古い順', () => {
  it('未確認（null）を先頭に置く（放置されている行を拾いたい）', () => {
    const list = [
      co('new.jp', { verified_at: '2026-09-10T00:00:00Z' }),
      co('never.jp', { verified_at: null }),
      co('old.jp', { verified_at: '2026-06-01T00:00:00Z' }),
    ]
    expect(names(sortAgentCompanies(list, 'verifiedOldest'))).toEqual(['never.jp', 'old.jp', 'new.jp'])
  })
})

describe('並びが揺れないこと', () => {
  it('同じ値ばかりでもドメインで決まる（上から潰す作業ができる）', () => {
    const same = ['c.jp', 'a.jp', 'b.jp'].map((d) =>
      co(d, { company_name: '同名株式会社', license_status: 'notfound', first_seen_at: '2026-05-05T00:00:00Z' }))
    for (const key of AGENT_SORT_OPTIONS.map((o) => o.value)) {
      expect(names(sortAgentCompanies(same, key))).toEqual(['a.jp', 'b.jp', 'c.jp'])
    }
  })

  it('日付が壊れていても落ちない', () => {
    const list = [co('a.jp', { first_seen_at: 'これは日付ではない' }), co('b.jp')]
    expect(() => sortAgentCompanies(list, 'newest')).not.toThrow()
    expect(sortAgentCompanies(list, 'newest')).toHaveLength(2)
  })
})

describe('sortMetaLabel: 並びの基準になっている値を行に出す', () => {
  it('登録日順なら初回登録日', () => {
    expect(sortMetaLabel(co('a.jp', { first_seen_at: '2026-09-01T00:00:00Z' }), 'newest')).toBe('初回 2026/09/01')
    expect(sortMetaLabel(co('a.jp', { first_seen_at: '2026-09-01T00:00:00Z' }), 'oldest')).toBe('初回 2026/09/01')
  })

  it('最終確認順なら確認日。未確認はそう書く', () => {
    expect(sortMetaLabel(co('a.jp', { verified_at: '2026-07-08T00:00:00Z' }), 'verifiedOldest')).toBe('確認 2026/07/08')
    expect(sortMetaLabel(co('a.jp', { verified_at: null }), 'verifiedOldest')).toBe('未確認')
  })

  it('基準が日付でない並びでは出さない（情報を増やさない）', () => {
    expect(sortMetaLabel(co('a.jp'), 'name')).toBeNull()
    expect(sortMetaLabel(co('a.jp'), 'status')).toBeNull()
  })
})
