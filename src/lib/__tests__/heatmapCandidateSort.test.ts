import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  HEATMAP_SORT_DEFAULT,
  HEATMAP_SORT_OPTIONS,
  isRateSort,
  listCaption,
  sortLabel,
  sortMetaLabel,
  type HeatmapSortKey,
} from '../heatmapCandidateSort'

/**
 * 人材マップの並び替え（2026-10-20 営業の要望）。
 *
 * 並べるのは DB（`candidates_by_prefecture`）なので、画面側に残るのは
 * 「キーの集合」と「言葉」だけ。**キーが SQL とズレると、押せるのに並びが変わらない**
 * （既定の新しい順に落ちる）＝一番気付きにくい壊れ方なので、SQL を文字列として突き合わせる。
 */
const SQL = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/20261020_heatmap_candidate_sort.sql'),
  'utf8',
)

describe('人材マップの並び替え', () => {
  it('画面のキーが SQL の ORDER BY に全部ある', () => {
    for (const { value } of HEATMAP_SORT_OPTIONS) {
      if (value === HEATMAP_SORT_DEFAULT) continue // 既定はどの CASE にも載らない（素の created_at DESC）
      expect(SQL, `SQL が「${value}」を見ていない`).toContain(`p_sort = '${value}'`)
    }
  })

  it('SQL にしか無いキーを作らない（押せない並びを DB に残さない）', () => {
    const inSql = [...SQL.matchAll(/p_sort = '([a-z_]+)'/g)].map((m) => m[1])
    const known = HEATMAP_SORT_OPTIONS.map((o) => o.value)
    for (const key of new Set(inSql)) {
      expect(known, `SQL の「${key}」が画面に無い`).toContain(key)
    }
  })

  it('既定は新しい順（これまでの画面と同じ並び）', () => {
    expect(HEATMAP_SORT_DEFAULT).toBe('new')
    expect(HEATMAP_SORT_OPTIONS[0].value).toBe('new')
  })

  it('知らないキーでも既定の言葉に落ちる', () => {
    expect(sortLabel('rate_low')).toBe('単価が安い順')
    expect(sortLabel('zzz' as HeatmapSortKey)).toBe('新しい順')
  })

  it('見出しに件数の上限と今の並びを必ず書く（全員ではないことを隠さない）', () => {
    for (const { value, label } of HEATMAP_SORT_OPTIONS) {
      const cap = listCaption(value, 10, '7d')
      expect(cap).toContain('最大10件')
      expect(cap).toContain(label)
    }
  })

  it('単価順のときだけ未取得の行き先を書く', () => {
    expect(listCaption('rate_low', 10, '7d')).toContain('単価未取得は後ろ')
    expect(listCaption('rate_high', 10, 'all')).toContain('アーカイブ済みと単価未取得は後ろ')
    expect(listCaption('new', 10, 'all')).not.toContain('後ろ')
    expect(isRateSort('old')).toBe(false)
  })

  it('単価で並べたときは行に単価を出す（基準が見えないと確かめられない）', () => {
    const live = { desired_rate: '70万', is_archived: false }
    expect(sortMetaLabel(live, 'rate_low')).toBe('70万')
    expect(sortMetaLabel({ desired_rate: null, is_archived: false }, 'rate_high')).toBe('単価未取得')
    // アーカイブ済みは単価の列を持たない。「未取得」と書くと抽出漏れに見える
    expect(sortMetaLabel({ desired_rate: null, is_archived: true }, 'rate_low')).toBe('単価なし（アーカイブ）')
  })

  it('日時の並びでは行に何も足さない（日時は元から出ている）', () => {
    const live = { desired_rate: '70万', is_archived: false }
    expect(sortMetaLabel(live, 'new')).toBeNull()
    expect(sortMetaLabel(live, 'old')).toBeNull()
  })

  it('押しても並びが変わらないボタンを出さない（星は本番で0人・2026-10-20 実測）', () => {
    expect(HEATMAP_SORT_OPTIONS.map((o) => o.value)).not.toContain('star')
    expect(SQL).not.toContain("p_sort = 'star'")
  })
})
