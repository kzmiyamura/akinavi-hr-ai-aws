import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COMMERCIAL_FLOW_OPTIONS as RULE_FLOWS,
  EMPLOYMENT_TYPE_OPTIONS as RULE_TYPES,
} from '../db/notificationRules'
import {
  HEATMAP_EMPLOYMENT_OPTIONS,
  HEATMAP_FILTER_EMPTY,
  HEATMAP_FLOW_OPTIONS,
  HEATMAP_TOGGLE_OPTIONS,
  filterChips,
  filterNotes,
  filterQueryKey,
  isFilterActive,
  toRpcParams,
  toggleValue,
  type HeatmapFilterState,
} from '../heatmapFilters'

/**
 * 人材マップの絞り込み（2026-10-20 営業の要望「自社の社員とかも入れて」）。
 *
 * 絞るのは DB（`prefecture_counts` / `candidates_by_prefecture`）なので、画面側に残るのは
 * 「選択肢」と「言葉」だけ。**値が SQL とズレると、押せるのに何も変わらない**
 * （空配列として扱われて全員出る）＝一番気付きにくい壊れ方なので SQL と突き合わせる。
 */
const SQL = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/20261020_2_heatmap_affiliation_filter.sql'),
  'utf8',
)

const withFilter = (p: Partial<HeatmapFilterState>): HeatmapFilterState => ({ ...HEATMAP_FILTER_EMPTY, ...p })

describe('人材マップの絞り込み', () => {
  it('商流の値は SQL の flow_bucket が返すものと同じ', () => {
    for (const { value } of HEATMAP_FLOW_OPTIONS) {
      expect(SQL, `flow_bucket が「${value}」を返さない`).toContain(`'${value}'`)
    }
  })

  it('言葉は通知タブの選択肢の部分集合（同じ「自社」が画面ごとに別の意味にならないように）', () => {
    for (const { value } of HEATMAP_FLOW_OPTIONS) {
      expect(RULE_FLOWS as readonly string[], `通知タブに無い商流「${value}」`).toContain(value)
    }
    for (const { value } of HEATMAP_EMPLOYMENT_OPTIONS) {
      expect(RULE_TYPES as readonly string[], `通知タブに無い雇用形態「${value}」`).toContain(value)
    }
  })

  it('押しても誰も出ない選択肢を出さない（本番実測 2026-10-20）', () => {
    const flows = HEATMAP_FLOW_OPTIONS.map((o) => o.value as string)
    const types = HEATMAP_EMPLOYMENT_OPTIONS.map((o) => o.value as string)
    // 2社先以降 4人 / 派遣社員 14人 / 業務委託 10人（1,878人中）。県で割ると必ず0人になる
    expect(flows).not.toContain('2社先以降')
    expect(types).not.toContain('派遣社員')
    expect(types).not.toContain('業務委託')
    // 一番多い組み合わせ（自社×フリーランス・自社×正社員）は必ず押せる
    expect(flows).toContain('自社')
    expect(types).toContain('正社員')
    expect(types).toContain('フリーランス')
  })

  it('同じボタンを押したら外れる', () => {
    expect(toggleValue(['自社'], '1社先')).toEqual(['自社', '1社先'])
    expect(toggleValue(['自社', '1社先'], '自社')).toEqual(['1社先'])
  })

  it('既定は何も絞っていない（開いた瞬間に人が消えない）', () => {
    expect(isFilterActive(HEATMAP_FILTER_EMPTY)).toBe(false)
    expect(filterChips(HEATMAP_FILTER_EMPTY)).toEqual([])
    expect(filterNotes(HEATMAP_FILTER_EMPTY, 'all')).toEqual([])
  })

  it('空の配列は null で渡す（SQL 側の「指定なし」と同じ意味にする）', () => {
    expect(toRpcParams(HEATMAP_FILTER_EMPTY)).toEqual({
      flows: null, types: null, availableNow: false, hasResume: false,
    })
    expect(toRpcParams(withFilter({ flows: ['自社'], types: ['正社員'] }))).toEqual({
      flows: ['自社'], types: ['正社員'], availableNow: false, hasResume: false,
    })
  })

  it('SQL は「指定なし」を cardinality 0 で判定している（null も空配列も通す）', () => {
    expect(SQL).toContain('COALESCE(cardinality(p_flows), 0) = 0')
    expect(SQL).toContain('COALESCE(cardinality(p_types), 0) = 0')
  })

  it('絞ったら消える人を必ず画面に書く（黙って減らすと取りこぼしに見える）', () => {
    const notes = filterNotes(withFilter({ flows: ['自社'] }), '7d')
    expect(notes.join('')).toContain('所属が取れていない人は出ません')
    expect(filterNotes(withFilter({ availableNow: true }), '7d').join('')).toContain('稼働時期が書かれていない')
    // 経歴書は「ある人だけ」が言葉どおりなので、注記は増やさない
    expect(filterNotes(withFilter({ hasResume: true }), '7d')).toHaveLength(0)
  })

  it('全期間で絞ったらアーカイブ済みを除くことを書く（SQL でも除いている）', () => {
    expect(filterNotes(withFilter({ hasResume: true }), 'all').join('')).toContain('アーカイブ済み')
    // 絞っていなければ注記は出さない（アーカイブ済みはちゃんと出ている）
    expect(filterNotes(HEATMAP_FILTER_EMPTY, 'all')).toEqual([])
    // SQL 側: 絞り込みが1つでも入ったらアーカイブ側の枝を通さない
    expect(SQL).toContain('NOT COALESCE(p_available_now, false)')
    expect(SQL).toContain('NOT COALESCE(p_has_resume, false)')
  })

  it('見出しに出す言葉は押したボタンそのまま（別名を作らない）', () => {
    const chips = filterChips(withFilter({ flows: ['自社'], types: ['正社員', '契約社員'], hasResume: true }))
    expect(chips).toEqual(['自社', '正社員・契約社員', '経歴書あり'])
  })

  it('キャッシュのキーが条件ごとに変わる（古い結果が出ないように）', () => {
    const a = filterQueryKey(withFilter({ flows: ['自社'] }))
    const b = filterQueryKey(withFilter({ types: ['自社' as never] }))
    const c = filterQueryKey(withFilter({ flows: ['自社'], availableNow: true }))
    expect(new Set([a, b, c, filterQueryKey(HEATMAP_FILTER_EMPTY)]).size).toBe(4)
  })

  it('はい/いいえのボタンは説明に判定を書く（人材タブと NULL の扱いが逆なので）', () => {
    const avail = HEATMAP_TOGGLE_OPTIONS.find((o) => o.key === 'availableNow')
    expect(avail?.title).toContain('未記載の人は出ません')
    expect(SQL).toContain('parse_available_from')
  })
})
