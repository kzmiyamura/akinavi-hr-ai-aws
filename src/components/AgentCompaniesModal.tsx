import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Building2, ChevronDown, Loader2, X } from 'lucide-react'
import { fetchAllAgentCompanies, updateAgentCompanyStatus } from '../lib/db/agentCompanies'
import type { AgentCompany, LicenseStatus } from '../lib/db/agentCompanies'

const LICENSE_STATUS_OPTIONS: { value: LicenseStatus; label: string; color: string }[] = [
  { value: 'unknown', label: '未確認', color: 'text-gray-500' },
  { value: 'haken', label: '派遣可', color: 'text-blue-700' },
  { value: 'shokai', label: '紹介可', color: 'text-green-700' },
  { value: 'both', label: '派遣・紹介可', color: 'text-blue-700' },
  { value: 'none', label: '免許なし', color: 'text-red-600' },
]

function AgentCompanyRow({
  company,
  onUpdate,
}: {
  company: AgentCompany
  onUpdate: (status: LicenseStatus, hakenNum?: string, shokaiNum?: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<LicenseStatus>(company.license_status)
  const [hakenNum, setHakenNum] = useState(company.haken_number ?? '')
  const [shokaiNum, setShokaiNum] = useState(company.shokai_number ?? '')

  const handleSave = useCallback(() => {
    onUpdate(status, hakenNum || undefined, shokaiNum || undefined)
    setEditing(false)
  }, [status, hakenNum, shokaiNum, onUpdate])

  const statusOpt = LICENSE_STATUS_OPTIONS.find(o => o.value === company.license_status)

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer min-w-0"
        onClick={() => setEditing(v => !v)}
      >
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
          company.license_status === 'haken' || company.license_status === 'both' ? 'bg-blue-100 text-blue-700' :
          company.license_status === 'shokai' ? 'bg-green-100 text-green-700' :
          company.license_status === 'none' ? 'bg-red-100 text-red-600' :
          'bg-gray-100 text-gray-500'
        }`}>
          {statusOpt?.label ?? '未確認'}
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-gray-800 truncate block">{company.company_name ?? '（会社名不明）'}</span>
          <span className="text-[10px] text-gray-400">{company.domain}</span>
        </div>
        {company.haken_number && (
          <span className="text-[10px] text-blue-600 shrink-0 hidden sm:block">{company.haken_number}</span>
        )}
        <ChevronDown size={12} className={`text-gray-300 shrink-0 transition-transform ${editing ? 'rotate-180' : ''}`} />
      </div>
      {editing && (
        <div className="border-t border-gray-100 px-3 py-3 bg-gray-50 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <select
              value={status}
              onChange={e => setStatus(e.target.value as LicenseStatus)}
              className="border border-gray-200 rounded px-2 py-1 text-xs"
            >
              {LICENSE_STATUS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          {(status === 'haken' || status === 'both') && (
            <input
              type="text"
              placeholder="派遣許可番号（例: 派13-123456）"
              value={hakenNum}
              onChange={e => setHakenNum(e.target.value)}
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs"
            />
          )}
          {(status === 'shokai' || status === 'both') && (
            <input
              type="text"
              placeholder="職業紹介許可番号（例: 13-ユ123456）"
              value={shokaiNum}
              onChange={e => setShokaiNum(e.target.value)}
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs"
            />
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1"
            >
              保存
            </button>
          </div>
          {company.verified_at && (
            <p className="text-[10px] text-gray-400">
              最終確認: {new Date(company.verified_at).toLocaleDateString('ja-JP')} by {company.verified_by}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function AgentCompaniesContent() {
  const queryClient = useQueryClient()
  const [searchText, setSearchText] = useState('')
  const [filterStatus, setFilterStatus] = useState<LicenseStatus | 'all'>('all')
  const [showAll, setShowAll] = useState(false)

  const { data: companies = [], isLoading } = useQuery({
    queryKey: ['agent-companies'],
    queryFn: fetchAllAgentCompanies,
  })

  const updateMutation = useMutation({
    mutationFn: ({ domain, status, hakenNum, shokaiNum }: { domain: string; status: LicenseStatus; hakenNum?: string; shokaiNum?: string }) =>
      updateAgentCompanyStatus(domain, {
        license_status: status,
        haken_number: hakenNum ?? null,
        shokai_number: shokaiNum ?? null,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-companies'] }),
  })

  const filtered = companies.filter(c => {
    if (searchText && !c.company_name?.toLowerCase().includes(searchText.toLowerCase()) && !c.domain.includes(searchText)) return false
    if (filterStatus !== 'all' && c.license_status !== filterStatus) return false
    return true
  })
  const displayList = showAll ? filtered : filtered.slice(0, 30)

  const statusCounts = {
    unknown: companies.filter(c => c.license_status === 'unknown').length,
    haken: companies.filter(c => c.license_status === 'haken' || c.license_status === 'both').length,
    none: companies.filter(c => c.license_status === 'none').length,
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        メール送信元の会社一覧です。派遣免許の確認状況を手動で設定できます。
      </p>

      {/* サマリー */}
      <div className="flex gap-2 text-xs flex-wrap">
        <span className="bg-gray-100 text-gray-600 rounded px-2 py-1">全 {companies.length} 社</span>
        <span className="bg-orange-50 text-orange-600 rounded px-2 py-1">未確認 {statusCounts.unknown}社</span>
        <span className="bg-blue-50 text-blue-700 rounded px-2 py-1">派遣可 {statusCounts.haken}社</span>
        <span className="bg-red-50 text-red-600 rounded px-2 py-1">免許なし {statusCounts.none}社</span>
      </div>

      {/* フィルター */}
      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          placeholder="会社名・ドメインで検索"
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          className="border border-gray-200 rounded px-2 py-1 text-xs flex-1 min-w-0 max-w-48"
        />
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as LicenseStatus | 'all')}
          className="border border-gray-200 rounded px-2 py-1 text-xs"
        >
          <option value="all">全ステータス</option>
          {LICENSE_STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* 一覧 */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
          <Loader2 size={14} className="animate-spin" />読み込み中…
        </div>
      ) : (
        <div className="space-y-1">
          {displayList.map(company => (
            <AgentCompanyRow
              key={company.domain}
              company={company}
              onUpdate={(status, hakenNum, shokaiNum) =>
                updateMutation.mutate({ domain: company.domain, status, hakenNum, shokaiNum })
              }
            />
          ))}
          {!showAll && filtered.length > 30 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full text-xs text-blue-600 hover:text-blue-800 py-2 text-center"
            >
              残り {filtered.length - 30} 社を表示
            </button>
          )}
          {filtered.length === 0 && (
            <p className="text-xs text-gray-400 py-4 text-center">該当する会社がありません</p>
          )}
        </div>
      )}
    </div>
  )
}

/** 人材ページヘッダーから呼び出すポップアップモーダル */
export function AgentCompaniesModal() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors shrink-0"
        title="派遣・紹介会社の免許確認状況を管理"
      >
        <Building2 size={14} />
        会社管理
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
          {/* オーバーレイ */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          {/* モーダル本体 */}
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[75vh] flex flex-col">
            {/* ヘッダー */}
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
              <Building2 size={16} className="text-blue-600 shrink-0" />
              <h2 className="text-base font-semibold text-gray-800 flex-1">派遣・紹介会社管理</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded"
              >
                <X size={16} />
              </button>
            </div>
            {/* コンテンツ（スクロール可） */}
            <div className="overflow-y-auto flex-1 px-5 py-4">
              <AgentCompaniesContent />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
