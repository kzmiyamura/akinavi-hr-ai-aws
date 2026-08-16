import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Pencil, Plus, Trash2 } from 'lucide-react'
import type { DataEnv } from '../lib/dataEnv'
import {
  createNotificationRule,
  deleteNotificationRule,
  getNotifyStatus,
  isTableMissingError,
  listNotificationRules,
  notificationRulesQueryKey,
  updateNotificationRule,
  type NotificationRule,
  type NotificationRuleInput,
} from '../lib/db/notificationRules'

interface Props {
  dataEnv: DataEnv
  nickname: string
}

interface FormState {
  label: string
  name_keyword: string
  skills: string // カンマ区切り入力
  station_keyword: string
  notify_email: string
}

const EMPTY_FORM: FormState = { label: '', name_keyword: '', skills: '', station_keyword: '', notify_email: '' }

const inputCls =
  'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

function toInput(form: FormState): NotificationRuleInput {
  return {
    label: form.label.trim(),
    name_keyword: form.name_keyword.trim(),
    skill_keywords: form.skills.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
    station_keyword: form.station_keyword.trim(),
    notify_email: form.notify_email.trim(),
    enabled: true,
  }
}

function validate(form: FormState): string | null {
  if (!form.notify_email.trim()) return '通知先メールアドレスを入力してください'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.notify_email.trim())) return 'メールアドレスの形式が正しくありません'
  const hasCondition =
    form.name_keyword.trim() !== '' || form.skills.trim() !== '' || form.station_keyword.trim() !== ''
  if (!hasCondition) return '条件（名前・スキル・最寄駅のいずれか）を1つ以上指定してください'
  return null
}

export function NotificationsPage({ dataEnv, nickname }: Props) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const rulesQuery = useQuery({
    queryKey: notificationRulesQueryKey(dataEnv),
    queryFn: () => listNotificationRules(dataEnv),
    retry: false,
  })

  const statusQuery = useQuery({
    queryKey: ['notify_status'],
    queryFn: getNotifyStatus,
    refetchInterval: 60_000,
    retry: false,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: notificationRulesQueryKey(dataEnv) })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const input = toInput(form)
      if (editingId) await updateNotificationRule(editingId, input)
      else await createNotificationRule(input, dataEnv, nickname)
    },
    onSuccess: () => {
      setForm(EMPTY_FORM)
      setEditingId(null)
      setFormError(null)
      invalidate()
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : String(e)),
  })

  const toggleMutation = useMutation({
    mutationFn: (rule: NotificationRule) => updateNotificationRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: invalidate,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteNotificationRule(id),
    onSuccess: invalidate,
  })

  const startEdit = (rule: NotificationRule) => {
    setEditingId(rule.id)
    setForm({
      label: rule.label,
      name_keyword: rule.name_keyword,
      skills: rule.skill_keywords.join(', '),
      station_keyword: rule.station_keyword,
      notify_email: rule.notify_email,
    })
    setFormError(null)
  }

  const handleSubmit = () => {
    const err = validate(form)
    if (err) {
      setFormError(err)
      return
    }
    saveMutation.mutate()
  }

  const tableMissing = rulesQuery.isError && isTableMissingError(rulesQuery.error)

  return (
    <div className="max-w-6xl mx-auto w-full p-3 sm:p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Bell size={18} className="text-blue-600" />
        <h2 className="text-base sm:text-lg font-bold text-gray-800">通知ルール</h2>
        <span className="text-xs text-gray-400">条件に合う人材が登録・更新されたらメールでお知らせ</span>
      </div>

      {tableMissing && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-lg px-4 py-3">
          通知機能のデータベース準備がまだ完了していません（Supabase復旧日にマイグレーション
          <code className="mx-1 text-xs bg-amber-100 px-1 rounded">add_notification_rules.sql</code>
          を適用すると使えるようになります）。
        </div>
      )}

      {statusQuery.data?.lastError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          <b>送信エラー:</b> {statusQuery.data.lastError}
        </div>
      )}

      {/* 追加・編集フォーム */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">
          {editingId ? 'ルールを編集' : 'ルールを追加'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs text-gray-500 space-y-1">
            <span>ルール名（任意）</span>
            <input className={inputCls} value={form.label} placeholder="例: Java人材ウォッチ"
              onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label className="text-xs text-gray-500 space-y-1">
            <span>通知先メールアドレス <span className="text-red-500">*</span></span>
            <input className={inputCls} type="email" value={form.notify_email} placeholder="you@example.com"
              onChange={(e) => setForm({ ...form, notify_email: e.target.value })} />
          </label>
          <label className="text-xs text-gray-500 space-y-1">
            <span>人材名・イニシャル（部分一致）</span>
            <input className={inputCls} value={form.name_keyword} placeholder="例: T.K"
              onChange={(e) => setForm({ ...form, name_keyword: e.target.value })} />
          </label>
          <label className="text-xs text-gray-500 space-y-1">
            <span>スキル（カンマ区切り・いずれかを含む）</span>
            <input className={inputCls} value={form.skills} placeholder="例: Java, C#, AS400"
              onChange={(e) => setForm({ ...form, skills: e.target.value })} />
          </label>
          <label className="text-xs text-gray-500 space-y-1">
            <span>最寄駅・都道府県（部分一致）</span>
            <input className={inputCls} value={form.station_keyword} placeholder="例: 西船橋 / 千葉"
              onChange={(e) => setForm({ ...form, station_keyword: e.target.value })} />
          </label>
        </div>
        <p className="text-[11px] text-gray-400">
          名前・スキル・最寄駅は指定したものをすべて満たす人材に通知します（AND）。
          ただし<b>スキル欄の中は「いずれか1つ」（OR）</b>です（例:「大阪府」＋「Java, C#」＝大阪府で Java か C# の人）。
          どれか1つ以上の条件が必須。
        </p>
        {formError && <p className="text-xs text-red-600">{formError}</p>}
        <div className="flex gap-2">
          <button
            onClick={handleSubmit}
            disabled={saveMutation.isPending || tableMissing}
            className="flex items-center gap-1.5 bg-blue-600 text-white rounded-lg px-4 py-1.5 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Plus size={14} />
            {editingId ? '更新する' : '追加する'}
          </button>
          {editingId && (
            <button
              onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setFormError(null) }}
              className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5"
            >
              キャンセル
            </button>
          )}
        </div>
      </div>

      {/* ルール一覧 */}
      <div className="space-y-2">
        {rulesQuery.isLoading && <p className="text-sm text-gray-400 py-6 text-center">読み込み中...</p>}
        {rulesQuery.isError && !tableMissing && (
          <p className="text-sm text-red-600">{(rulesQuery.error as Error).message}</p>
        )}
        {rulesQuery.data?.length === 0 && (
          <p className="text-sm text-gray-400 py-6 text-center">通知ルールはまだありません</p>
        )}
        {rulesQuery.data?.map((rule) => (
          <div key={rule.id}
            className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex flex-col sm:flex-row sm:items-center gap-3 ${rule.enabled ? '' : 'opacity-55'}`}>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm text-gray-800 truncate">
                  {rule.label || '（名称なし）'}
                </span>
                {!rule.enabled && (
                  <span className="text-[10px] bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">停止中</span>
                )}
              </div>
              <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-0.5">
                {rule.name_keyword && <span>名前: <b className="text-gray-700">{rule.name_keyword}</b></span>}
                {rule.skill_keywords.length > 0 && (
                  // OR 判定なので区切りも「+」ではなく「/」で見せる（2026-08-17）
                  <span>スキル: <b className="text-gray-700">{rule.skill_keywords.join(' / ')}</b>のいずれか</span>
                )}
                {rule.station_keyword && <span>駅: <b className="text-gray-700">{rule.station_keyword}</b></span>}
                <span>→ {rule.notify_email}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => toggleMutation.mutate(rule)}
                className={`text-xs rounded-lg px-2.5 py-1.5 border transition-colors ${
                  rule.enabled
                    ? 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    : 'border-blue-200 text-blue-600 hover:bg-blue-50'
                }`}
              >
                {rule.enabled ? '停止' : '再開'}
              </button>
              <button onClick={() => startEdit(rule)} title="編集"
                className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors">
                <Pencil size={15} />
              </button>
              <button
                onClick={() => {
                  if (window.confirm(`通知ルール「${rule.label || rule.notify_email}」を削除しますか？`)) {
                    deleteMutation.mutate(rule.id)
                  }
                }}
                title="削除"
                className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-gray-400 leading-relaxed">
        チェックは5分間隔で自動実行されます。送信元は人材メール取り込みと同じMicrosoftアカウントです。
        初回はメール送信権限（Mail.Send）の同意が必要なため、送信エラーが表示された場合は
        設定タブからMicrosoft再連携を行ってください。同じ人材に同じルールで二重通知はされません。
      </p>
    </div>
  )
}
