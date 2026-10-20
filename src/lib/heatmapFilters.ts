/** 人材マップの絞り込み（所属・稼働・経歴書）。
 *
 *  2026-10-20 営業の要望「人材マップ絞り込みに自社の社員とかも入れて」
 *  → 続けて「使いやすさを考えて。人材マップ使う想定で何が絞り込んでソート出来たら使いやすいか」。
 *
 *  ■ 人材マップで営業がやっていること
 *    案件を受ける → その県に誰がいるか見る → **「この人、今うちから出せるか」** を判断する。
 *    出せるかを決めるのは3つで、どれも元から DB にあるのに画面から絞れなかった:
 *      ① 所属（商流×雇用形態）… 自社の社員なら直接出せる。2社先の人は中抜きが深い
 *      ② 稼働時期            … 来月空く人を今日の案件には出せない
 *      ③ 経歴書があるか      … 無い人は客先に出せない（名簿メールの人に多い）
 *    スキルと期間は既にボタンで絞れるので、ここに足す。
 *
 *  ■ 選択肢は実測で決めた（prod 1,878人・2026-10-20。詳細は
 *    `supabase/migrations/20261020_2_heatmap_affiliation_filter.sql` の冒頭）
 *      自社 982 / 1社先 553 / **2社先以降 4**
 *      正社員 669 / フリーランス 638 / 契約社員 133 / **派遣社員 14 / 業務委託 10**
 *    太字のものは**ボタンにしない**。県で割ると必ず0人になり「絞り込みが壊れている」と
 *    読まれる（星を並び替えに入れなかったのと同じ判断）。RPC は値を受け取れるので、
 *    必要になればここに1行足すだけでよい（SQL は変更不要）。
 *
 *  ■ 言葉は通知タブと同じものだけを使う
 *    通知ルールの選択肢（`notificationRules.ts` / `notify-candidates/match.ts`）の**部分集合**に
 *    なっていることを `__tests__/heatmapFilters.test.ts` で突き合わせる。
 *    同じ「自社」が画面ごとに違う意味になるのを防ぐため（丸めの正は SQL の `flow_bucket()`）。
 */

export const HEATMAP_FLOW_OPTIONS = [
  { value: '自社', label: '自社', title: '自社に所属している人（直接出せる）' },
  { value: '1社先', label: '1社先', title: '1社挟んでいる人' },
] as const

export const HEATMAP_EMPLOYMENT_OPTIONS = [
  { value: '正社員', label: '正社員', title: '雇用形態が正社員の人' },
  { value: 'フリーランス', label: 'フリー', title: '雇用形態がフリーランスの人' },
  { value: '契約社員', label: '契約社員', title: '雇用形態が契約社員の人' },
] as const

/** リモート／常駐（2026-10-20 営業の要望「人材マップの絞り込みでリモート関連」）。
 *
 *  値は raw_profile.workStyleTag そのもの＝人材タブのカードに出ている Wifi 印と同じ言葉。
 *  判定の正は inbound-email の `deriveWorkStyleTag`（`__tests__` でソースと突き合わせる）。
 *  本番実測（2026-10-20・1,913人）: 併用可 472 / 常駐可 378 / リモート希望 222 / **未取得 841(44%)**。
 *  案件がリモートなら［リモート希望］＋［併用可］、常駐なら［常駐可］＋［併用可］を押す想定。
 *  ⚠ remoteAvailable（true/false）は使わない。「リモート可と読めた」だけで、常駐に出せるかが分からない */
export const HEATMAP_WORK_STYLE_OPTIONS = [
  { value: 'リモート希望', label: 'リモート希望', title: 'フルリモート・リモート前提と書かれている人（常駐案件には出しにくい）' },
  { value: '併用可', label: '併用可', title: 'リモートと出社の併用（週N日出社 など）と書かれている人' },
  { value: '常駐可', label: '常駐可', title: '常駐・出社可と書かれている人' },
] as const

export type HeatmapFlow = (typeof HEATMAP_FLOW_OPTIONS)[number]['value']
export type HeatmapEmployment = (typeof HEATMAP_EMPLOYMENT_OPTIONS)[number]['value']
export type HeatmapWorkStyle = (typeof HEATMAP_WORK_STYLE_OPTIONS)[number]['value']

export interface HeatmapFilterState {
  /** 商流。空＝指定なし。複数選べて中は OR */
  flows: HeatmapFlow[]
  /** 雇用形態。空＝指定なし。複数選べて中は OR（商流とは AND） */
  types: HeatmapEmployment[]
  /** 稼働時期が今日以前と**書かれている**人だけ。未記載の人は出ない */
  availableNow: boolean
  /** 経歴書（添付・Drive・Box のいずれか）がある人だけ */
  hasResume: boolean
  /** ワークスタイル（workStyleTag）。空＝指定なし。中は OR。未取得（44%）は出ない */
  workStyles: HeatmapWorkStyle[]
}

export const HEATMAP_FILTER_EMPTY: HeatmapFilterState = {
  flows: [],
  types: [],
  availableNow: false,
  hasResume: false,
  workStyles: [],
}

/** 「はい/いいえ」で押す絞り込み。ボタンの言葉と説明をここに置く */
export const HEATMAP_TOGGLE_OPTIONS: {
  key: 'availableNow' | 'hasResume'
  label: string
  title: string
}[] = [
  {
    key: 'availableNow',
    label: 'すぐ稼働OK',
    // ⚠ 人材タブの「この日までに稼働できる人」は読み取れない人を**残す**が、こちらは
    //    言葉が断定なので通さない。違いが読めるように説明に書く（本番実測で82%は読める）
    title: '稼働時期が今日以前と書かれている人だけ（即日を含む／未記載の人は出ません）',
  },
  {
    key: 'hasResume',
    label: '経歴書あり',
    title: '経歴書・スキルシートが紐付いている人だけ（本番で78%）',
  },
]

/** 押した値を入れ外しする（同じものを押したら外す） */
export function toggleValue<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

export function isFilterActive(f: HeatmapFilterState): boolean {
  return f.flows.length > 0 || f.types.length > 0 || f.availableNow || f.hasResume || f.workStyles.length > 0
}

/** 今かかっている絞り込みを短い言葉にする（一覧の見出しに並べる） */
export function filterChips(f: HeatmapFilterState): string[] {
  const chips: string[] = []
  if (f.flows.length > 0) chips.push(f.flows.join('・'))
  if (f.types.length > 0) chips.push(f.types.join('・'))
  for (const t of HEATMAP_TOGGLE_OPTIONS) if (f[t.key]) chips.push(t.label)
  if (f.workStyles.length > 0) chips.push(f.workStyles.join('・'))
  return chips
}

/**
 * 画面に出す注記。**黙って人を減らさないための文**。
 *
 *   ① 所属で絞ると「取れていない人」が消える（商流18% / 雇用形態22%が未取得）
 *   ② 全期間でも、絞るとアーカイブ済み（7日より前）は出せない
 *      — `candidates_archive_light` が所属・稼働時期・経歴書の列を持たないため
 */
export function filterNotes(f: HeatmapFilterState, period: '7d' | 'all'): string[] {
  const notes: string[] = []
  if (!isFilterActive(f)) return notes
  if (f.flows.length > 0 || f.types.length > 0) {
    notes.push('所属が取れていない人は出ません（商流18%・雇用形態22%が未取得）')
  }
  if (f.availableNow) notes.push('稼働時期が書かれていない人は出ません（18%）')
  // 44% は多い。黙って減らすと「人がいない」と読まれるので、割合を必ず出す
  if (f.workStyles.length > 0) notes.push('リモート・常駐の記載が無い人は出ません（44%が未取得）')
  if (period === 'all') {
    notes.push('アーカイブ済み（7日より前）は所属・稼働時期・経歴書・ワークスタイルの記録が無いため除いています')
  }
  return notes
}

/** RPC に渡す形。空配列は null（SQL 側は「指定なし」として扱う） */
export function toRpcParams(f: HeatmapFilterState): {
  flows: string[] | null
  types: string[] | null
  availableNow: boolean
  hasResume: boolean
  workStyles: string[] | null
} {
  return {
    flows: f.flows.length > 0 ? [...f.flows] : null,
    types: f.types.length > 0 ? [...f.types] : null,
    availableNow: f.availableNow,
    hasResume: f.hasResume,
    workStyles: f.workStyles.length > 0 ? [...f.workStyles] : null,
  }
}

/** React Query のキーに入れる値。**取り違えるとキャッシュを跨いで古い結果が出る** */
export function filterQueryKey(f: HeatmapFilterState): string {
  return [
    f.flows.join(','), f.types.join(','),
    f.availableNow ? 'av' : '', f.hasResume ? 'rs' : '',
    f.workStyles.join(','),
  ].join('|')
}
