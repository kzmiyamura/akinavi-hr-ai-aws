/**
 * AI校正の1日上限（app_config.shadow_max_per_day）の読み書き。
 *
 * ■ なぜ画面から変えられるようにしたか
 *   これまで SQL を流さないと変えられなかった。ワーカーは毎サイクル（約5分）
 *   この値を読み直すので、保存すれば pm2 の再起動なしでその場で効く。
 *
 * ■ ここで固定したいこと
 *   値は jsonb なので **数値でも文字列でも入りうる**（画面・SQL・手作業で書き方が違う）。
 *   ワーカー側 `maxPerDay()` は2回まで JSON を解いてから Number にする。
 *   **画面側が同じ解き方をしないと「SQLで入れた値が画面に出ない」**ことになる。
 *
 *   保存範囲もワーカーと揃える。ワーカーは範囲外を**黙って既定値に落とす**ので、
 *   画面で弾かないと「保存したのに効かない」が起きる。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const maybeSingle = vi.fn()
const upsert = vi.fn()

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      upsert,
    }),
  },
}))

const {
  getShadowWorkerSettings,
  saveShadowWorkerSettings,
  SHADOW_WORKER_DEFAULTS,
  SHADOW_MAX_PER_DAY_LIMIT,
} = await import('../db/shadowWorkerSettings')

beforeEach(() => {
  maybeSingle.mockReset()
  upsert.mockReset()
  upsert.mockResolvedValue({ error: null })
})

describe('読み込み', () => {
  it('数値で入っていれば読める', async () => {
    maybeSingle.mockResolvedValue({ data: { value: 300 } })
    expect((await getShadowWorkerSettings()).maxPerDay).toBe(300)
  })

  it('文字列で入っていても読める（SQLや手作業で入る形）', async () => {
    maybeSingle.mockResolvedValue({ data: { value: '300' } })
    expect((await getShadowWorkerSettings()).maxPerDay).toBe(300)
  })

  it('二重に引用された文字列でも読める（過去に実在した形）', async () => {
    maybeSingle.mockResolvedValue({ data: { value: '"300"' } })
    expect((await getShadowWorkerSettings()).maxPerDay).toBe(300)
  })

  it('未設定なら既定値', async () => {
    maybeSingle.mockResolvedValue({ data: null })
    expect((await getShadowWorkerSettings()).maxPerDay).toBe(SHADOW_WORKER_DEFAULTS.maxPerDay)
  })

  it('壊れた値・範囲外は既定値に倒す（ワーカーと同じ判断）', async () => {
    for (const v of ['abc', 0, -5, SHADOW_MAX_PER_DAY_LIMIT + 1, null, {}]) {
      maybeSingle.mockResolvedValue({ data: { value: v } })
      expect((await getShadowWorkerSettings()).maxPerDay, String(v))
        .toBe(SHADOW_WORKER_DEFAULTS.maxPerDay)
    }
  })

  it('小数は切り捨てる', async () => {
    maybeSingle.mockResolvedValue({ data: { value: 300.9 } })
    expect((await getShadowWorkerSettings()).maxPerDay).toBe(300)
  })
})

describe('保存', () => {
  it('数値のまま書く（SQLから見て型が揃う）', async () => {
    await saveShadowWorkerSettings({ maxPerDay: 300 })
    expect(upsert).toHaveBeenCalledWith(
      [{ key: 'shadow_max_per_day', value: 300 }],
      { onConflict: 'key' },
    )
  })

  it('ワーカーが受け付けない値は保存させない（保存したのに効かない、を防ぐ）', async () => {
    for (const n of [0, -1, SHADOW_MAX_PER_DAY_LIMIT + 1, NaN]) {
      await expect(saveShadowWorkerSettings({ maxPerDay: n }), String(n)).rejects.toThrow()
    }
    expect(upsert).not.toHaveBeenCalled()
  })

  it('上限ちょうどは通す', async () => {
    await saveShadowWorkerSettings({ maxPerDay: SHADOW_MAX_PER_DAY_LIMIT })
    expect(upsert).toHaveBeenCalled()
  })

  it('保存に失敗したら例外にする（黙って成功にしない）', async () => {
    upsert.mockResolvedValue({ error: { message: '権限がありません' } })
    await expect(saveShadowWorkerSettings({ maxPerDay: 200 })).rejects.toThrow('権限がありません')
  })
})
