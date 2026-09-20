import { supabase } from '../supabase'

/**
 * 免許の確認状況。
 *
 * `notfound`（照合できず）と `none`（免許なし）は別物。厚労省サイトで引けなかった
 * だけの会社を「免許なし」と赤字で出していたため、実在の派遣元が取引不可に見え、
 * さらに p_require_haken の絞り込みでその会社の人材がマッチングから消えていた。
 * 「無い」と断定してよいのは人が確認したときだけ（2026-09-12）。
 */
export type LicenseStatus = 'unknown' | 'haken' | 'shokai' | 'both' | 'notfound' | 'none'

export interface AgentCompany {
  domain: string
  company_name: string | null
  haken_number: string | null
  // 厚労省「人材サービス総合サイト」の許可番号詳細ページへの完全なURL。
  // 末尾の事業所インデックス（同一許可番号内のどの事業所か）は番号ごとに異なり
  // 固定値では推測できないため、verify-agent-license が検索結果HTMLから
  // サイト自身が生成した正しいリンクをそのまま抽出して保存したもの。
  haken_detail_url: string | null
  shokai_number: string | null
  license_status: LicenseStatus
  verified_at: string | null
  verified_by: string | null
  source: 'email' | 'manual'
  memo: string | null
  first_seen_at: string
  updated_at: string
}

/**
 * 取引先ごとの人材の傾向（agent_company_stats ビュー）。
 *
 * 取引先によって送ってくる人材の性格がはっきり違うことが実測で分かったので
 * 会社管理画面に出す（2026-09-20）。実測例:
 *   i-standard.jp  214人 単価80万 経験26年 53歳 添付41%  自社100% … ベテラン専門
 *   ai-more.co.jp  140人 単価55万 経験 8年 32歳 添付64%  自社14%  … 若手・又聞き
 *   j-tech.co.jp    99人 単価70万 経験24年 47歳 **添付6%** 自社97% … 経歴書が来ない
 *
 * 「経歴書添付率6%」は毎回こちらから催促が要るという運用コストそのもの。
 * 取引先に改善を依頼する根拠になる。
 *
 * ⚠ 集計はビュー側で閉じている。**画面から candidates を引かないこと**（egress）。
 */
export interface AgentCompanyStats {
  domain: string
  people: number
  rate_median: number | null
  rate_p25: number | null
  rate_p75: number | null
  exp_median: number | null
  age_median: number | null
  /** 経歴書（解析可能な添付）が付いていた割合 % */
  attach_pct: number
  /** 自社要員の割合 %。低いほど又聞き（間に会社が挟まる） */
  own_pct: number
  last_seen_at: string | null
  /** 直近7日の人数。今も動いている取引先かどうか */
  people_7d: number
}

/** ドメイン → 傾向 のマップ。1社1行なので全件取っても軽い（約300行） */
export async function fetchAgentCompanyStats(): Promise<Map<string, AgentCompanyStats>> {
  const { data, error } = await supabase.from('agent_company_stats').select('*')
  if (error) throw new Error(`agent_company_stats取得失敗: ${error.message}`)
  const map = new Map<string, AgentCompanyStats>()
  for (const row of data ?? []) map.set(row.domain, row as AgentCompanyStats)
  return map
}

/** 全社取得（設定画面用）*/
export async function fetchAllAgentCompanies(): Promise<AgentCompany[]> {
  const { data, error } = await supabase
    .from('agent_companies')
    .select('*')
    .order('first_seen_at', { ascending: false })
  if (error) throw new Error(`agent_companies取得失敗: ${error.message}`)
  return (data ?? []) as AgentCompany[]
}

/** ドメイン → ステータスのマップを取得（マッチング・候補者カード用）*/
export async function fetchAgentDomainMap(): Promise<Map<string, AgentCompany>> {
  const { data, error } = await supabase
    .from('agent_companies')
    .select('domain, company_name, license_status, haken_number, haken_detail_url, shokai_number, verified_at')
  if (error) throw new Error(`agent_companies取得失敗: ${error.message}`)
  const map = new Map<string, AgentCompany>()
  for (const row of data ?? []) {
    map.set(row.domain, row as AgentCompany)
  }
  return map
}

/** license_status を手動更新 */
export async function updateAgentCompanyStatus(
  domain: string,
  update: {
    license_status: LicenseStatus
    haken_number?: string | null
    shokai_number?: string | null
    memo?: string | null
    verified_by?: string
  },
): Promise<void> {
  const { error } = await supabase
    .from('agent_companies')
    .update({
      ...update,
      verified_at: new Date().toISOString(),
    })
    .eq('domain', domain)
  if (error) throw new Error(`ステータス更新失敗: ${error.message}`)
}

/** メールドメインから候補者の免許ステータスを判定 */
export function getLicenseStatusFromEmail(
  fromEmail: string | undefined,
  domainMap: Map<string, AgentCompany>,
): LicenseStatus | null {
  if (!fromEmail) return null
  const domain = fromEmail.split('@')[1]?.toLowerCase()
  if (!domain) return null
  return domainMap.get(domain)?.license_status ?? null
}

/** ステータスのラベルと色 */
export function licenseStatusLabel(status: LicenseStatus | null): {
  label: string
  color: string
  bg: string
} {
  switch (status) {
    case 'haken':
      return { label: '派遣可', color: 'text-blue-700', bg: 'bg-blue-100' }
    case 'shokai':
      return { label: '紹介可', color: 'text-green-700', bg: 'bg-green-100' }
    case 'both':
      return { label: '派遣・紹介可', color: 'text-blue-700', bg: 'bg-blue-100' }
    case 'none':
      return { label: '免許なし', color: 'text-red-700', bg: 'bg-red-100' }
    case 'notfound':
      return { label: '照合できず', color: 'text-amber-700', bg: 'bg-amber-100' }
    case 'unknown':
      return { label: '未確認', color: 'text-gray-500', bg: 'bg-gray-100' }
    default:
      return { label: '不明', color: 'text-gray-400', bg: 'bg-gray-50' }
  }
}
