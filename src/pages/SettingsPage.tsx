import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Save, RefreshCw } from 'lucide-react'
import {
  getEmailSettings,
  saveEmailAddressSettings,
  startFullImport,
} from '../lib/db/emailSettings'

function formatDateInput(date: Date): string {
  return date.toISOString().split('T')[0]
}

function defaultSinceDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return formatDateInput(d)
}

export function SettingsPage() {
  const queryClient = useQueryClient()

  const { data: settings, isLoading, error } = useQuery({
    queryKey: ['emailSettings'],
    queryFn: getEmailSettings,
  })

  // フォーム状態
  const [humanAddress, setHumanAddress] = useState('')
  const [projectAddress, setProjectAddress] = useState('')
  const [useAiClassification, setUseAiClassification] = useState(false)
  const [sinceDate, setSinceDate] = useState(defaultSinceDate)

  // settings が取得できたらフォームに反映
  useEffect(() => {
    if (!settings) return
    setHumanAddress(settings.email_human_address)
    setProjectAddress(settings.email_project_address)
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

  return (
    <div className="space-y-6">
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
            <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800">
              <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
              全件取り込み中
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              新着のみ
            </span>
          )}
        </div>

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
              disabled={isFullMode}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>

          <p className="text-xs text-gray-500">
            大量メールがある場合、取り込みには時間がかかります。5分ごとに処理が進みます。
          </p>

          {/* 全件取り込み開始ボタン */}
          <div>
            <button
              type="button"
              onClick={() => fullImportMutation.mutate()}
              disabled={isFullMode || fullImportMutation.isPending || !sinceDate}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-60 transition-colors"
            >
              {fullImportMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              全件取り込み開始
            </button>
            {isFullMode && (
              <p className="mt-2 text-xs text-yellow-700">
                全件取り込み中です。完了すると自動的に新着のみモードに戻ります。
              </p>
            )}
            {fullImportMutation.isSuccess && !isFullMode && (
              <span className="ml-3 text-sm text-green-600">取り込みを開始しました</span>
            )}
            {fullImportMutation.isError && (
              <span className="ml-3 text-sm text-red-600">
                開始に失敗しました: {String(fullImportMutation.error)}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
