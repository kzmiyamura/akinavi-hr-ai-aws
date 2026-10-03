/**
 * 相場の取得が「マイグレーション未適用」で既存機能を壊さないこと。
 *
 * ⚠ デプロイ順の事故を止めるテスト。
 *   `20261003_rate_market_by_experience.sql` を流す前にフロントが本番に出ると、
 *   `skill_rate_market_by_exp` と `exp_rate_market` が存在せず PostgREST が
 *   エラーを返す。ここで throw すると**今まで出ていたスキル単位の相場バッジまで消える**。
 *
 *   「今あるものを崩さない」が先。新しい2本は無ければ無いものとして扱い、
 *   スキル単位の相場（以前から本番にあるビュー）へ落とす。
 *   逆に、そのスキル単位のビューが読めないのは本当の異常なので隠さない。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Res = { data: unknown; error: { message: string } | null }

/** テーブル名ごとに返すものを差し替えられるダミー */
let responses: Record<string, Res> = {}
const MISSING = { message: 'relation "public.skill_rate_market_by_exp" does not exist' }

vi.mock('../../supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => Promise.resolve(responses[table] ?? { data: [], error: null }),
    }),
  },
}))

const { fetchRateMarket, compareToMarket } = await import('../skillRateMarket')

const SKILL_ROW = { skill: 'VMware', people: 722, with_rate: 700, p25: 65, median: 75, p75: 90 }

beforeEach(() => {
  responses = {}
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('fetchRateMarket', () => {
  it('経験帯のビューが無くてもスキル単位の相場は返る', async () => {
    responses = {
      skill_rate_market: { data: [SKILL_ROW], error: null },
      skill_rate_market_by_exp: { data: null, error: MISSING },
      exp_rate_market: { data: null, error: { message: 'relation "public.exp_rate_market" does not exist' } },
    }

    const market = await fetchRateMarket()

    expect(market.bySkill.get('VMware')?.median).toBe(75)
    expect(market.bySkillExp.size).toBe(0)
    expect(market.byExp.size).toBe(0)
  })

  it('経験帯が引けないときは従来どおりスキル単位で比較できる', async () => {
    responses = {
      skill_rate_market: { data: [SKILL_ROW], error: null },
      skill_rate_market_by_exp: { data: null, error: MISSING },
      exp_rate_market: { data: null, error: MISSING },
    }

    const market = await fetchRateMarket()
    const cmp = compareToMarket('50万', ['VMware'], 1, market)

    // 経験帯が無いので第3段（スキル単位）に落ちる＝これが今の本番の挙動
    expect(cmp?.basis).toBe('skill')
    expect(cmp?.median).toBe(75)
  })

  it('読めなかったことは黙らない（console.warn に出す）', async () => {
    responses = {
      skill_rate_market: { data: [SKILL_ROW], error: null },
      skill_rate_market_by_exp: { data: null, error: MISSING },
    }

    await fetchRateMarket()

    expect(console.warn).toHaveBeenCalled()
    const msg = String((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])
    expect(msg).toContain('skill_rate_market_by_exp')
  })

  it('スキル単位のビューが読めないのは本当の異常なので投げる', async () => {
    responses = {
      skill_rate_market: { data: null, error: { message: 'permission denied' } },
    }

    await expect(fetchRateMarket()).rejects.toThrow('permission denied')
  })
})
