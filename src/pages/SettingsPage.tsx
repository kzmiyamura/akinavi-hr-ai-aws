import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Save, RefreshCw, Pause, Play } from 'lucide-react'
import {
  getEmailSettings,
  saveEmailAddressSettings,
  startFullImport,
  pauseFullImport,
  resumeFullImport,
  getImportProgress,
  getConnectionStatuses,
} from '../lib/db/emailSettings'

function formatDateInput(date: Date): string {
  return date.toISOString().split('T')[0]
}

function defaultSinceDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return formatDateInput(d)
}

const ACCOUNT_LIST_PROD = [
  { account: 'human_prod', label: '人材用（本番）' },
  { account: 'project_prod', label: '案件用（本番）' },
]

const ACCOUNT_LIST_DEMO = [
  { account: 'human_dev', label: '人材用（デモ）' },
  { account: 'project_dev', label: '案件用（デモ）' },
]

interface SettingsPageProps {
  demoUiEnabled: boolean
}

export function SettingsPage({ demoUiEnabled }: SettingsPageProps) {
  const queryClient = useQueryClient()

  const { data: settings, isLoading, error } = useQuery({
    queryKey: ['emailSettings'],
    queryFn: getEmailSettings,
    // 全件取り込み中・一時停止中は15秒ごとに自動更新
    refetchInterval: (query) => {
      const mode = query.state.data?.email_poll_mode
      return mode === 'full' || mode === 'paused' ? 15_000 : false
    },
  })

  const {
    data: connectionStatuses,
    isLoading: isConnectionLoading,
    refetch: refetchConnections,
  } = useQuery({
    queryKey: ['connectionStatuses'],
    queryFn: getConnectionStatuses,
  })

  const [connectingAccount, setConnectingAccount] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

  async function handleConnect(account: string) {
    setConnectingAccount(account)
    setConnectError(null)
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
      const redirectUri = encodeURIComponent(window.location.origin + '/auth/callback')
      const res = await fetch(
        `${supabaseUrl}/functions/v1/microsoft-oauth?step=start&account=${account}&redirect_uri=${redirectUri}`,
        {
          headers: {
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
        },
      )
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData?.error ?? `HTTP ${res.status}`)
      }
      const { authorizeUrl } = await res.json()
      window.location.href = authorizeUrl
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err))
      setConnectingAccount(null)
    }
  }

  // フォーム状態
  const [humanAddress, setHumanAddress] = useState('')
  const [projectAddress, setProjectAddress] = useState('')
  const [humanDevAddress, setHumanDevAddress] = useState('')
  const [projectDevAddress, setProjectDevAddress] = useState('')
  const [useAiClassification, setUseAiClassification] = useState(false)
  const [sinceDate, setSinceDate] = useState(defaultSinceDate)

  // settings が取得できたらフォームに反映
  useEffect(() => {
    if (!settings) return
    setHumanAddress(settings.email_human_address)
    setProjectAddress(settings.email_project_address)
    setHumanDevAddress(settings.email_human_dev_address)
    setProjectDevAddress(settings.email_project_dev_address)
    setUseAiClassification(settings.email_use_ai_classification)
    if (settings.email_full_import_since) {
      setSinceDate(settings.email_full_import_since)
    }
  }, [settings])

  // アドレス設定保存
  const saveMutation = useMutation({
    mutationFn: () =>
      saveEmailAddressSettings({
        email_human_address: humanAddress,
        email_project_address: projectAddress,
        email_human_dev_address: humanDevAddress,
        email_project_dev_address: projectDevAddress,
        email_use_ai_classification: useAiClassification,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emailSettings'] })
    },
  })

  // 全件取り込み開始
  const fullImportMutation = useMutation({
    mutationFn: () => startFullImport(sinceDate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emailSettings'] })
    },
  })

  // 一時停止
  const pauseMutation = useMutation({
    mutationFn: pauseFullImport,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['emailSettings'] }),
  })

  // 再開
  const resumeMutation = useMutation({
    mutationFn: resumeFullImport,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['emailSettings'] }),
  })

  // 進捗カウント（全件モード中・一時停止中のみ取得）
  const { data: progressCount = 0 } = useQuery({
    queryKey: ['importProgress', settings?.email_full_import_since],
    queryFn: () => getImportProgress(settings?.email_full_import_since ?? ''),
    enabled: settings?.email_poll_mode === 'full' || settings?.email_poll_mode === 'paused',
    refetchInterval: settings?.email_poll_mode === 'full' ? 15_000 : false,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" />
        読み込み中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700">
        設定の読み込みに失敗しました: {String(error)}
      </div>
    )
  }

  const pollMode = settings?.email_poll_mode ?? 'incremental'
  const isFullMode = pollMode === 'full'
  const isPaused = pollMode === 'paused'
  const isImportActive = isFullMode || isPaused

  return (
    <div className="space-y-6">
      {/* ---- Microsoft アカウント連携 ---- */}
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">Microsoft アカウント連携</h2>
          <button
            type="button"
            onClick={() => refetchConnections()}
            disabled={isConnectionLoading}
            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={isConnectionLoading ? 'animate-spin' : ''} />
            接続状態を再確認
          </button>
        </div>

        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
          ⚠️ 事前に Azure アプリのリダイレクト URI に{' '}
          <code className="font-mono bg-amber-100 px-1 rounded">
            {window.location.origin}/auth/callback
          </code>{' '}
          を追加してください
        </p>

        <div className="divide-y divide-gray-100">
          {[...ACCOUNT_LIST_PROD, ...(demoUiEnabled ? ACCOUNT_LIST_DEMO : [])].map(({ account, label }) => {
            const connected = connectionStatuses?.[account] ?? false
            const isConnecting = connectingAccount === account
            return (
              <div key={account} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-700">{label}</span>
                  {isConnectionLoading ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-400">
                      <Loader2 size={10} className="animate-spin" />
                      確認中
                    </span>
                  ) : connected ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                      連携済み
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                      未連携
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleConnect(account)}
                  disabled={isConnecting || connectingAccount !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
                >
                  {isConnecting ? (
                    <>
                      <Loader2 size={12} className="animate-spin" />
                      リダイレクト中...
                    </>
                  ) : connected ? (
                    '再連携'
                  ) : (
                    '連携する'
                  )}
                </button>
              </div>
            )
          })}
        </div>

        {connectError && (
          <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            連携の開始に失敗しました: {connectError}
          </p>
        )}
      </section>

      {/* ---- メール設定 ---- */}
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-4">メール設定</h2>

        <div className="space-y-4">
          {/* 人材用メールアドレス */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              人材用メールアドレス
            </label>
            <input
              type="email"
              value={humanAddress}
              onChange={e => setHumanAddress(e.target.value)}
              placeholder="akinavi.hr.ai.voice.human@outlook.jp"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="mt-1 text-xs text-gray-400">表示用・参照用です。実際の認証情報は Supabase Secrets で管理します。</p>
          </div>

          {/* 案件用メールアドレス */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              案件用メールアドレス
            </label>
            <input
              type="email"
              value={projectAddress}
              onChange={e => setProjectAddress(e.target.value)}
              placeholder="akinavi.hr.ai.voice.project@outlook.jp"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="mt-1 text-xs text-gray-400">表示用・参照用です。実際の認証情報は Supabase Secrets で管理します。</p>
          </div>

          {/* デモ用メールアドレス（デモモード有効時のみ表示） */}
          {demoUiEnabled && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  人材用メールアドレス（デモ）
                </label>
                <input
                  type="email"
                  value={humanDevAddress}
                  onChange={e => setHumanDevAddress(e.target.value)}
                  placeholder="demo.human@outlook.jp"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="mt-1 text-xs text-gray-400">表示用・参照用です。実際の認証情報は Supabase Secrets で管理します。</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  案件用メールアドレス（デモ）
                </label>
                <input
                  type="email"
                  value={projectDevAddress}
                  onChange={e => setProjectDevAddress(e.target.value)}
                  placeholder="demo.project@outlook.jp"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="mt-1 text-xs text-gray-400">表示用・参照用です。実際の認証情報は Supabase Secrets で管理します。</p>
              </div>
            </>
          )}

          {/* AI種別判断 */}
          <div className="flex items-start gap-3 pt-1">
            <input
              id="useAiClassification"
              type="checkbox"
              checked={useAiClassification}
              onChange={e => setUseAiClassification(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <div>
              <label htmlFor="useAiClassification" className="text-sm font-medium text-gray-700 cursor-pointer">
                同じメールアドレスをAIで種別判断する
              </label>
              {useAiClassification && (
                <p className="mt-0.5 text-xs text-blue-600">
                  有効時は人材用メールアドレスのアカウントのみポーリングします
                </p>
              )}
              <p className="mt-0.5 text-xs text-gray-400">
                人材・案件が同じ受信箱に届く場合、Gemini AIで自動分類します
              </p>
            </div>
          </div>

          {/* 保存ボタン */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {saveMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              保存する
            </button>
            {saveMutation.isSuccess && (
              <span className="ml-3 text-sm text-green-600">保存しました</span>
            )}
            {saveMutation.isError && (
              <span className="ml-3 text-sm text-red-600">
                保存に失敗しました: {String(saveMutation.error)}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ---- 全件取り込み ---- */}
      <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-semibold text-gray-800">全件取り込み</h2>
          {isFullMode ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
              <Loader2 size={10} className="animate-spin" />
              取り込み中
            </span>
          ) : isPaused ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
              一時停止中
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              新着のみ
            </span>
          )}
        </div>

        {/* 進捗表示 */}
        {isImportActive && (
          <div className="mb-4 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
            <div className="flex items-center justify-between">
              <span>{settings?.email_full_import_since} 以降を取り込み中</span>
              <span className="font-semibold">{progressCount} 件処理済み</span>
            </div>
            <p className="mt-1 text-xs text-blue-600">
              5分ごとにバックグラウンドで処理が進みます。解析済みデータは人材・案件タブに随時反映されます。
            </p>
          </div>
        )}

        <div className="space-y-4">
          {/* 開始日 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              取り込み開始日
            </label>
            <input
              type="date"
              value={sinceDate}
              onChange={e => setSinceDate(e.target.value)}
              disabled={isImportActive}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>

          {/* ボタン群 */}
          <div className="flex flex-wrap items-center gap-3">
            {/* 全件取り込み開始 */}
            {!isImportActive && (
              <button
                type="button"
                onClick={() => fullImportMutation.mutate()}
                disabled={fullImportMutation.isPending || !sinceDate}
                className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-60 transition-colors"
              >
                {fullImportMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                全件取り込み開始
              </button>
            )}

            {/* 一時停止 */}
            {isFullMode && (
              <button
                type="button"
                onClick={() => pauseMutation.mutate()}
                disabled={pauseMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition-colors"
              >
                {pauseMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Pause size={14} />
                )}
                一時停止
              </button>
            )}

            {/* 再開 */}
            {isPaused && (
              <button
                type="button"
                onClick={() => resumeMutation.mutate()}
                disabled={resumeMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {resumeMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Play size={14} />
                )}
                再開
              </button>
            )}
          </div>

          {fullImportMutation.isSuccess && !isImportActive && (
            <p className="text-sm text-green-600">取り込みを開始しました</p>
          )}
          {fullImportMutation.isError && (
            <p className="text-sm text-red-600">開始に失敗しました: {String(fullImportMutation.error)}</p>
          )}
          {pauseMutation.isError && (
            <p className="text-sm text-red-600">一時停止に失敗しました: {String(pauseMutation.error)}</p>
          )}
          {resumeMutation.isError && (
            <p className="text-sm text-red-600">再開に失敗しました: {String(resumeMutation.error)}</p>
          )}
        </div>
      </section>
    </div>
  )
}
