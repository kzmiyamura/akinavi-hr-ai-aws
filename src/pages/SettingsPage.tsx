import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Save, RefreshCw, Pause, Play, CheckCircle, Circle, FileText } from 'lucide-react'
import {
  getEmailSettings,
  saveEmailAddressSettings,
  startFullImport,
  pauseFullImport,
  resumeFullImport,
  getImportProgress,
  getConnectionStatuses,
  getAutoMatchEnabled,
  saveAutoMatchEnabled,
  getProjectInboundEnabled,
  saveProjectInboundEnabled,
  getCandidateRetentionDays,
  saveCandidateRetentionDays,
  getAppMemo,
  saveAppMemo,
} from '../lib/db/emailSettings'
import {
  getMatchingSettings,
  saveMatchingSettings,
  MATCHING_DEFAULTS,
} from '../lib/db/matchingSettings'

function formatDateInput(date: Date): string {
  return date.toISOString().split('T')[0]
}

function defaultSinceDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return formatDateInput(d)
}

interface SettingsPageProps {
  demoUiEnabled: boolean
}

interface PendingConnect {
  account: string
  label: string
  address: string
}

export function SettingsPage({ demoUiEnabled }: SettingsPageProps) {
  const queryClient = useQueryClient()

  const { data: settings, isLoading, error } = useQuery({
    queryKey: ['emailSettings'],
    queryFn: getEmailSettings,
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

  // 案件メール解析 ON/OFF
  const { data: projectInboundEnabled = false } = useQuery({
    queryKey: ['projectInboundEnabled'],
    queryFn: getProjectInboundEnabled,
  })
  const projectInboundMutation = useMutation({
    mutationFn: saveProjectInboundEnabled,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projectInboundEnabled'] }),
  })

  // 自動マッチング ON/OFF
  const { data: autoMatchEnabled = true } = useQuery({
    queryKey: ['autoMatchEnabled'],
    queryFn: getAutoMatchEnabled,
  })
  const autoMatchMutation = useMutation({
    mutationFn: saveAutoMatchEnabled,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['autoMatchEnabled'] }),
  })

  // 人材データ保持日数
  const { data: retentionDays = 7 } = useQuery({
    queryKey: ['candidateRetentionDays'],
    queryFn: getCandidateRetentionDays,
  })
  const [retentionDaysInput, setRetentionDaysInput] = useState<number>(7)
  const retentionMutation = useMutation({
    mutationFn: (days: number) => saveCandidateRetentionDays(days),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['candidateRetentionDays'] }),
  })

  // マッチング設定
  const { data: matchingSettings } = useQuery({
    queryKey: ['matchingSettings'],
    queryFn: getMatchingSettings,
  })
  const [fastMaxCandidates, setFastMaxCandidates] = useState(MATCHING_DEFAULTS.fast_max_candidates_per_project)
  const [fastMaxProjects, setFastMaxProjects] = useState(MATCHING_DEFAULTS.fast_max_projects_per_candidate)

  useEffect(() => {
    if (!matchingSettings) return
    setFastMaxCandidates(matchingSettings.fast_max_candidates_per_project)
    setFastMaxProjects(matchingSettings.fast_max_projects_per_candidate)
  }, [matchingSettings])

  useEffect(() => {
    setRetentionDaysInput(retentionDays)
  }, [retentionDays])

  // アプリメモ
  const { data: savedMemo = '' } = useQuery({
    queryKey: ['appMemo'],
    queryFn: getAppMemo,
  })
  const [memo, setMemo] = useState('')
  useEffect(() => { setMemo(savedMemo) }, [savedMemo])
  const memoMutation = useMutation({
    mutationFn: (text: string) => saveAppMemo(text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appMemo'] }),
  })

  const saveMatchingMutation = useMutation({
    mutationFn: () => saveMatchingSettings({
      fast_max_candidates_per_project: fastMaxCandidates,
      fast_max_projects_per_candidate: fastMaxProjects,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['matchingSettings'] })
    },
  })

  // フォーム状態
  const [humanAddress, setHumanAddress] = useState('')
  const [projectAddress, setProjectAddress] = useState('')
  const [humanDevAddress, setHumanDevAddress] = useState('')
  const [projectDevAddress, setProjectDevAddress] = useState('')
  const [useAiClassification, setUseAiClassification] = useState(false)
  const [useAiClassificationDev, setUseAiClassificationDev] = useState(false)
  const [sinceDate, setSinceDate] = useState(defaultSinceDate)

  // DB に保存済みのアドレス値（変更検知に使用）
  const savedValuesRef = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!settings) return
    savedValuesRef.current = {
      human_prod: settings.email_human_address,
      project_prod: settings.email_project_address,
      human_dev: settings.email_human_dev_address,
      project_dev: settings.email_project_dev_address,
    }
    setHumanAddress(settings.email_human_address)
    setProjectAddress(settings.email_project_address)
    setHumanDevAddress(settings.email_human_dev_address)
    setProjectDevAddress(settings.email_project_dev_address)
    setUseAiClassification(settings.email_use_ai_classification)
    setUseAiClassificationDev(settings.email_use_ai_classification_dev)
    if (settings.email_full_import_since) {
      setSinceDate(settings.email_full_import_since)
    }
  }, [settings])

  // OAuth 確認ダイアログ
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectingAccount, setConnectingAccount] = useState<string | null>(null)

  // アドレス変更を検知してダイアログを表示
  function handleAddressBlur(account: string, label: string, currentValue: string) {
    const saved = savedValuesRef.current[account] ?? ''
    if (currentValue && currentValue !== saved) {
      setPendingConnect({ account, label, address: currentValue })
    }
  }

  // Microsoft OAuth リダイレクト開始
  async function startOAuth(account: string) {
    setConnectingAccount(account)
    setConnectError(null)
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
      const redirectUri = encodeURIComponent(window.location.origin + '/auth/callback')
      const res = await fetch(
        `${supabaseUrl}/functions/v1/microsoft-oauth?step=start&account=${account}&redirect_uri=${redirectUri}`,
        { headers: { Authorization: `Bearer ${supabaseAnonKey}` } },
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

  // 確認ダイアログで「連携を開始」
  async function handleConfirmConnect() {
    if (!pendingConnect) return
    const account = pendingConnect.account
    setPendingConnect(null)
    // アドレスを先に保存してからOAuth
    try {
      await saveEmailAddressSettings({
        email_human_address: humanAddress,
        email_project_address: projectAddress,
        email_human_dev_address: humanDevAddress,
        email_project_dev_address: projectDevAddress,
        email_use_ai_classification: useAiClassification,
        email_use_ai_classification_dev: useAiClassificationDev,
      })
      queryClient.invalidateQueries({ queryKey: ['emailSettings'] })
    } catch (_) {
      // 保存失敗でも OAuth は続行
    }
    await startOAuth(account)
  }

  // 確認ダイアログで「後で」→ アドレスだけ保存
  function handleSkipConnect() {
    setPendingConnect(null)
    saveMutation.mutate()
  }

  // アドレス設定保存
  const saveMutation = useMutation({
    mutationFn: () =>
      saveEmailAddressSettings({
        email_human_address: humanAddress,
        email_project_address: projectAddress,
        email_human_dev_address: humanDevAddress,
        email_project_dev_address: projectDevAddress,
        email_use_ai_classification: useAiClassification,
        email_use_ai_classification_dev: useAiClassificationDev,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emailSettings'] })
    },
  })

  // 全件取り込み開始
  const fullImportMutation = useMutation({
    mutationFn: () => startFullImport(sinceDate),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['emailSettings'] }),
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

  // 進捗カウント（全件モード中・一時停止中のみ）
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

  // メールアドレス入力フィールドの定義
  type AddressField = {
    account: string
    label: string
    placeholder: string
    value: string
    setter: (v: string) => void
  }
  const addressFieldsProd: AddressField[] = [
    {
      account: 'human_prod',
      label: '人材用メールアドレス（本番）',
      placeholder: 'akinavi.hr.ai.voice.human@outlook.jp',
      value: humanAddress,
      setter: setHumanAddress,
    },
    {
      account: 'project_prod',
      label: '案件用メールアドレス（本番）',
      placeholder: 'akinavi.hr.ai.voice.project@outlook.jp',
      value: projectAddress,
      setter: setProjectAddress,
    },
  ]
  const addressFieldsDemo: AddressField[] = [
    {
      account: 'human_dev',
      label: '人材用メールアドレス（デモ）',
      placeholder: 'demo.human@outlook.jp',
      value: humanDevAddress,
      setter: setHumanDevAddress,
    },
    {
      account: 'project_dev',
      label: '案件用メールアドレス（デモ）',
      placeholder: 'demo.project@outlook.jp',
      value: projectDevAddress,
      setter: setProjectDevAddress,
    },
  ]
  const addressFields = demoUiEnabled
    ? [...addressFieldsProd, ...addressFieldsDemo]
    : addressFieldsProd

  return (
    <>
      {/* ---- OAuth 確認ダイアログ ---- */}
      {pendingConnect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white shadow-2xl p-6">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Microsoftアカウントの連携</h3>
            <p className="text-sm text-gray-600 mb-2">
              <span className="font-medium">{pendingConnect.label}</span> のアドレスを変更しました。
            </p>
            <p className="text-sm font-mono bg-gray-50 rounded-lg px-3 py-2 mb-3 text-gray-700 break-all">
              {pendingConnect.address}
            </p>
            <p className="text-xs text-gray-500 mb-5">
              このアドレスの Microsoft アカウントでログインして連携を完了しますか？
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={handleSkipConnect}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                後で
              </button>
              <button
                type="button"
                onClick={handleConfirmConnect}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                連携を開始
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* ---- メール設定 ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-semibold text-gray-800">メール設定</h2>
            <button
              type="button"
              onClick={() => refetchConnections()}
              disabled={isConnectionLoading}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={11} className={isConnectionLoading ? 'animate-spin' : ''} />
              連携状態を更新
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-4">
            メールアドレスを入力・変更すると、Microsoftアカウントとの連携を開始するか確認します。
          </p>

          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-5">
            ⚠️ 事前に Azure アプリのリダイレクト URI に{' '}
            <code className="font-mono bg-amber-100 px-1 rounded">
              {window.location.origin}/auth/callback
            </code>{' '}
            を追加してください
          </p>

          <div className="space-y-4">
            {/* メールアドレス入力フィールド */}
            {addressFields.map(({ account, label, placeholder, value, setter }) => {
              const connected = connectionStatuses?.[account] ?? false
              const isConnecting = connectingAccount === account
              return (
                <div key={account}>
                  <div className="flex items-center gap-2 mb-1">
                    <label className="text-sm font-medium text-gray-700">{label}</label>
                    {isConnectionLoading || isConnecting ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-400">
                        <Loader2 size={9} className="animate-spin" />
                        {isConnecting ? 'リダイレクト中' : '確認中'}
                      </span>
                    ) : connected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                        <CheckCircle size={10} />
                        連携済み
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                        <Circle size={10} />
                        未連携
                      </span>
                    )}
                  </div>
                  <input
                    type="email"
                    value={value}
                    onChange={e => setter(e.target.value)}
                    onBlur={e => handleAddressBlur(account, label, e.target.value)}
                    placeholder={placeholder}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
              )
            })}

            {/* AI種別判断（本番） */}
            <div className="flex items-start gap-3 pt-2">
              <input
                id="useAiClassification"
                type="checkbox"
                checked={useAiClassification}
                onChange={e => setUseAiClassification(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <div>
                <label htmlFor="useAiClassification" className="text-sm font-medium text-gray-700 cursor-pointer">
                  同じメールアドレスをAIで種別判断する（本番）
                </label>
                {useAiClassification && (
                  <p className="mt-0.5 text-xs text-blue-600">
                    有効時は人材用アカウント（本番）のみポーリングします
                  </p>
                )}
                <p className="mt-0.5 text-xs text-gray-400">
                  人材・案件が同じ受信箱に届く場合、Gemini AIで自動分類します
                </p>
              </div>
            </div>

            {/* AI種別判断（デモ）— デモモード有効時のみ */}
            {demoUiEnabled && (
              <div className="flex items-start gap-3">
                <input
                  id="useAiClassificationDev"
                  type="checkbox"
                  checked={useAiClassificationDev}
                  onChange={e => setUseAiClassificationDev(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <div>
                  <label htmlFor="useAiClassificationDev" className="text-sm font-medium text-gray-700 cursor-pointer">
                    同じメールアドレスをAIで種別判断する（デモ）
                  </label>
                  {useAiClassificationDev && (
                    <p className="mt-0.5 text-xs text-blue-600">
                      有効時は人材用アカウント（デモ）のみポーリングします
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-gray-400">
                    デモ環境で人材・案件が同じ受信箱に届く場合、Gemini AIで自動分類します
                  </p>
                </div>
              </div>
            )}

            {/* 保存ボタン */}
            <div className="pt-1">
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
              {connectError && (
                <p className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  連携の開始に失敗しました: {connectError}
                </p>
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

            <div className="flex flex-wrap items-center gap-3">
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

        {/* ---- 案件メール解析 ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-1">案件メール解析</h2>
          <p className="text-xs text-gray-400 mb-4">受信した案件メールをAIで解析してDBに登録します。OFFの場合は案件メールをスキップします。</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">案件メール解析</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {projectInboundEnabled ? '有効 — 案件メールを解析・登録します' : '無効 — 案件メールをスキップします（デフォルト）'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => projectInboundMutation.mutate(!projectInboundEnabled)}
              disabled={projectInboundMutation.isPending}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                projectInboundEnabled ? 'bg-blue-600' : 'bg-gray-300'
              } disabled:opacity-50`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                projectInboundEnabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </section>

        {/* ---- 自動マッチング ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-1">自動マッチング</h2>
          <p className="text-xs text-gray-400 mb-4">毎朝 9:00 に前日登録の案件と人材を自動でマッチングします。</p>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">自動バッチ（毎日 JST 9:00）</p>
              <p className="text-xs text-gray-400 mt-0.5">
                {autoMatchEnabled ? '有効 — 毎朝自動でマッチングが実行されます' : '無効 — 手動マッチングのみ'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => autoMatchMutation.mutate(!autoMatchEnabled)}
              disabled={autoMatchMutation.isPending}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                autoMatchEnabled ? 'bg-blue-600' : 'bg-gray-300'
              } disabled:opacity-50`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                autoMatchEnabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </section>

        {/* ---- 人材データ保持期間 ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-1">人材データ保持期間</h2>
          <p className="text-xs text-gray-400 mb-4">登録から指定日数を超えた人材データを毎日 JST 0:00 に自動削除します。</p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={365}
              value={retentionDaysInput}
              onChange={e => setRetentionDaysInput(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-24 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-600">日間保持</span>
            <button
              type="button"
              onClick={() => retentionMutation.mutate(retentionDaysInput)}
              disabled={retentionMutation.isPending || retentionDaysInput === retentionDays}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {retentionMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
            {retentionMutation.isSuccess && <span className="text-sm text-green-600">保存しました</span>}
            {retentionMutation.isError && <span className="text-sm text-red-600">保存に失敗しました</span>}
          </div>
        </section>

        {/* ---- マッチング設定 ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-1">マッチング設定</h2>
          <p className="text-xs text-gray-400 mb-4">高速モード時の上限件数を設定します。</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                案件ごとの候補者上限（高速モード）
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={fastMaxCandidates}
                  onChange={e => setFastMaxCandidates(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-500">名（デフォルト: {MATCHING_DEFAULTS.fast_max_candidates_per_project}名）</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">1案件につき、必須スキル重複が多い順に上位N名のみAI採点します</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                人材ごとの案件上限（高速モード）
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={fastMaxProjects}
                  onChange={e => setFastMaxProjects(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-500">件（デフォルト: {MATCHING_DEFAULTS.fast_max_projects_per_candidate}件）</span>
              </div>
              <p className="mt-1 text-xs text-gray-400">1人材につき、必須スキル重複が多い順に上位N件のみAI採点します</p>
            </div>

            <div className="pt-1">
              <button
                type="button"
                onClick={() => saveMatchingMutation.mutate()}
                disabled={saveMatchingMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {saveMatchingMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                保存する
              </button>
              {saveMatchingMutation.isSuccess && (
                <span className="ml-3 text-sm text-green-600">保存しました</span>
              )}
              {saveMatchingMutation.isError && (
                <span className="ml-3 text-sm text-red-600">保存に失敗しました: {String(saveMatchingMutation.error)}</span>
              )}
            </div>
          </div>
        </section>

        {/* ---- 改善案・バグメモ ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-1">改善案・バグメモ</h2>
          <p className="text-xs text-gray-400 mb-3">気づいた改善点やバグをメモしておけます。全端末で共有されます。</p>
          <textarea
            value={memo}
            onChange={e => setMemo(e.target.value)}
            rows={8}
            placeholder={'例)\n・マッチングスコアが低い案件の原因を調査\n・モバイルで○○ボタンが押しにくい\n・スキル「React」と「React.js」が別扱いになっている'}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => memoMutation.mutate(memo)}
              disabled={memoMutation.isPending || memo === savedMemo}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {memoMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </button>
            {memoMutation.isSuccess && <span className="text-sm text-green-600">保存しました</span>}
            {memoMutation.isError && <span className="text-sm text-red-600">保存に失敗しました</span>}
          </div>
        </section>

        {/* ---- ドキュメント ---- */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-1">ドキュメント</h2>
          <p className="text-xs text-gray-400 mb-4">システムの仕様・フロー資料を閲覧できます。</p>
          <div className="space-y-2">
            {[
              { label: 'AIモデルフォールバックフロー', path: '/docs/ai_fallback_flow.pdf' },
              { label: 'マッチング候補者選定ロジック', path: '/docs/matching_candidate_selection.pdf' },
            ].map(({ label, path }) => (
              <a
                key={path}
                href={path}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 hover:border-blue-300 hover:text-blue-600 transition-colors"
              >
                <FileText size={15} className="shrink-0 text-gray-400" />
                {label}
              </a>
            ))}
          </div>
        </section>
      </div>
    </>
  )
}
