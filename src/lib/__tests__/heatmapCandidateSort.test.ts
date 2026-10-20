import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  HEATMAP_SORT_DEFAULT,
  HEATMAP_SORT_OPTIONS,
  hasSortValue,
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
/** ⚠ `candidates_by_prefecture` を**最後に作り直した**マイグレーションを見る。
 *  並び替えを足したのは 20261020_heatmap_candidate_sort.sql だが、同日の
 *  20261020_2_heatmap_affiliation_filter.sql が絞り込みと2つの並び（稼働・経験）を足して
 *  関数ごと作り直している。古い方を読むと、増えたキーを検査しないまま通ってしまう。 */
const SQL = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/20261020_2_heatmap_affiliation_filter.sql'),
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

  it('値が取れていない人の行き先を書く（単価・稼働時期・経験年数）', () => {
    expect(listCaption('rate_low', 10, '7d')).toContain('単価未取得は後ろ')
    expect(listCaption('rate_high', 10, 'all')).toContain('アーカイブ済みと単価未取得は後ろ')
    expect(listCaption('avail_soon', 10, '7d')).toContain('稼働時期未取得は後ろ')
    expect(listCaption('exp_high', 10, 'all')).toContain('アーカイブ済みと経験年数未取得は後ろ')
    expect(listCaption('new', 10, 'all')).not.toContain('後ろ')
    expect(isRateSort('old')).toBe(false)
  })

  it('並べた基準の値を行に出す（基準が見えないと確かめられない）', () => {
    const live = { desired_rate: '70万', available_from: '即日', experience_years: 12, is_archived: false }
    expect(sortMetaLabel(live, 'rate_low')).toBe('70万')
    expect(sortMetaLabel(live, 'avail_soon')).toBe('稼働 即日')
    expect(sortMetaLabel(live, 'exp_high')).toBe('経験 12年')
    expect(hasSortValue(live, 'avail_soon')).toBe(true)
  })

  it('稼働時期は書かれていた文字のまま出す（「即日」を日付に化かさない）', () => {
    const live = { desired_rate: null, available_from: '11月中旬〜', experience_years: null, is_archived: false }
    expect(sortMetaLabel(live, 'avail_soon')).toBe('稼働 11月中旬〜')
  })

  it('未取得とアーカイブ済みを書き分ける（アーカイブは列そのものが無い）', () => {
    const none = { desired_rate: null, available_from: null, experience_years: null, is_archived: false }
    expect(sortMetaLabel(none, 'rate_high')).toBe('単価未取得')
    expect(sortMetaLabel(none, 'avail_soon')).toBe('稼働時期未取得')
    expect(sortMetaLabel(none, 'exp_high')).toBe('経験年数未取得')
    expect(hasSortValue(none, 'exp_high')).toBe(false)
    // アーカイブ済みは単価・稼働時期・経験年数の列を持たない。「未取得」と書くと抽出漏れに見える
    const arch = { ...none, is_archived: true }
    expect(sortMetaLabel(arch, 'rate_low')).toBe('単価なし（アーカイブ）')
    expect(sortMetaLabel(arch, 'avail_soon')).toBe('稼働時期なし（アーカイブ）')
    expect(sortMetaLabel(arch, 'exp_high')).toBe('経験年数なし（アーカイブ）')
  })

  it('日時の並びでは行に何も足さない（日時は元から出ている）', () => {
    const live = { desired_rate: '70万', available_from: '即日', experience_years: 12, is_archived: false }
    expect(sortMetaLabel(live, 'new')).toBeNull()
    expect(sortMetaLabel(live, 'old')).toBeNull()
    expect(hasSortValue(live, 'new')).toBe(false)
  })

  it('経験年数0年を「未取得」と書かない（0 と null は違う）', () => {
    const zero = { desired_rate: null, available_from: null, experience_years: 0, is_archived: false }
    expect(sortMetaLabel(zero, 'exp_high')).toBe('経験 0年')
    expect(hasSortValue(zero, 'exp_high')).toBe(true)
  })

  it('押しても並びが変わらないボタンを出さない（星は本番で0人・2026-10-20 実測）', () => {
    expect(HEATMAP_SORT_OPTIONS.map((o) => o.value)).not.toContain('star')
    expect(SQL).not.toContain("p_sort = 'star'")
  })
})
