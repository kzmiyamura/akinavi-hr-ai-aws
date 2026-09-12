/** 派遣・紹介会社管理（人材画面「会社管理」）の並び替え。
 *
 *  2026-09-12 に223社まで掃除したが、それでも1画面には収まらない。
 *  営業がやりたいことは主に2つで、並び順が固定だとどちらもやりにくかった:
 *    ・「照合できず」を上から順に潰して、人が免許を確認する
 *    ・付き合いのある会社を名前で探す
 *
 *  判定に使うマスタは無いので、全部この場（クライアント側）で並べる。
 *  一覧は既に取得済みなので追加の通信は発生しない。
 */
import type { AgentCompany, LicenseStatus } from './db/agentCompanies'

export type AgentSortKey =
  | 'newest'
  | 'oldest'
  | 'name'
  | 'status'
  | 'verifiedOldest'

export const AGENT_SORT_OPTIONS: { value: AgentSortKey; label: string }[] = [
  { value: 'newest', label: '登録が新しい順' },
  { value: 'oldest', label: '登録が古い順' },
  { value: 'name', label: '会社名順' },
  { value: 'status', label: '要確認を先に' },
  { value: 'verifiedOldest', label: '最終確認が古い順' },
]

/**
 * 「要確認を先に」の並び。人が手を入れる必要がある順に並べる。
 * 照合できず → 未確認 → 紹介のみ → 免許なし → 派遣可 の順。
 * 「派遣可」は確認が済んでいるので最後で良い。「免許なし」は人が確認した結論なので
 * 照合できず（＝結論が出ていない）より後ろに置く。
 */
const STATUS_ORDER: Record<LicenseStatus, number> = {
  notfound: 0,
  unknown: 1,
  shokai: 2,
  none: 3,
  haken: 4,
  both: 5,
}

/** 日時を比較用の数値にする。値なしは「いちばん古い」側に寄せる（放置されている行を拾いたい） */
function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** 会社名の比較。名前が無い行は常に最後（画面では「（会社名不明）」と出る） */
function compareName(a: AgentCompany, b: AgentCompany): number {
  const an = a.company_name?.trim() ?? ''
  const bn = b.company_name?.trim() ?? ''
  if (!an && !bn) return a.domain.localeCompare(b.domain)
  if (!an) return 1
  if (!bn) return -1
  // 日本語の並びにする（カタカナ・かな・漢字が混ざるので localeCompare に任せる）
  return an.localeCompare(bn, 'ja') || a.domain.localeCompare(b.domain)
}

/** YYYY/MM/DD。値なしは null */
function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 行に添える補助表示。**並び替えの基準になっている値そのもの**を出す。
 * 日付順に並べたのに日付が見えないと、並んでいるのか確かめようがない。
 * 基準が日付でない並び（会社名順・要確認を先に）では出さない（情報を増やさない）。
 */
export function sortMetaLabel(company: AgentCompany, key: AgentSortKey): string | null {
  if (key === 'newest' || key === 'oldest') {
    const d = shortDate(company.first_seen_at)
    return d ? `初回 ${d}` : null
  }
  if (key === 'verifiedOldest') {
    const d = shortDate(company.verified_at)
    return d ? `確認 ${d}` : '未確認'
  }
  return null
}

/**
 * 並び替えた新しい配列を返す（引数は変更しない）。
 * 同じ値のときはドメインで決めるので、**同じ入力なら必ず同じ順序**になる
 * （並びが毎回揺れると、上から順に潰す作業ができない）。
 */
export function sortAgentCompanies(
  companies: readonly AgentCompany[],
  key: AgentSortKey,
): AgentCompany[] {
  const list = [...companies]
  switch (key) {
    case 'newest':
      return list.sort((a, b) =>
        timeOf(b.first_seen_at) - timeOf(a.first_seen_at) || a.domain.localeCompare(b.domain))
    case 'oldest':
      return list.sort((a, b) =>
        timeOf(a.first_seen_at) - timeOf(b.first_seen_at) || a.domain.localeCompare(b.domain))
    case 'name':
      return list.sort(compareName)
    case 'status':
      return list.sort((a, b) =>
        (STATUS_ORDER[a.license_status] ?? 99) - (STATUS_ORDER[b.license_status] ?? 99)
        || compareName(a, b))
    case 'verifiedOldest':
      return list.sort((a, b) =>
        timeOf(a.verified_at) - timeOf(b.verified_at) || compareName(a, b))
    default:
      return list
  }
}
