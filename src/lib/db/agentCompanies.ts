import { supabase } from '../supabase'

export type LicenseStatus = 'unknown' | 'haken' | 'shokai' | 'both' | 'none'

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
    case 'unknown':
      return { label: '未確認', color: 'text-gray-500', bg: 'bg-gray-100' }
    default:
      return { label: '不明', color: 'text-gray-400', bg: 'bg-gray-50' }
  }
}
