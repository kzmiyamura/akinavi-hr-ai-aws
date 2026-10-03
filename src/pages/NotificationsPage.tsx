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
  // ── 2026-10-01 追加。数値は空文字＝指定なしとして持つ（0 と区別するため） ──────
  age_min: string
  age_max: string
  experience_years_min: string
  skill_years_min: string
  exclude_level_c: boolean
  text_keywords: string // カンマ区切り入力
  include_unknown: boolean
}

const EMPTY_FORM: FormState = {
  label: '', name_keyword: '', skills: '', station_keyword: '', notify_email: '',
  age_min: '', age_max: '', experience_years_min: '', skill_years_min: '',
  exclude_level_c: false, text_keywords: '', include_unknown: true,
}

/** 空文字・非数値は「指定なし」＝null。0 を指定なしに丸めない */
function toNum(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

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
    age_min: toNum(form.age_min),
    age_max: toNum(form.age_max),
    experience_years_min: toNum(form.experience_years_min),
    skill_years_min: toNum(form.skill_years_min),
    exclude_level_c: form.exclude_level_c,
    text_keywords: form.text_keywords.split(/[、,]/).map((s) => s.trim()).filter(Boolean),
    include_unknown: form.include_unknown,
  }
}

function validate(form: FormState): string | null {
  if (!form.notify_email.trim()) return '通知先メールアドレスを入力してください'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.notify_email.trim())) return 'メールアドレスの形式が正しくありません'
  const hasCondition =
    form.name_keyword.trim() !== '' || form.skills.trim() !== '' || form.station_keyword.trim() !== ''
    || form.age_min.trim() !== '' || form.age_max.trim() !== ''
    || form.experience_years_min.trim() !== '' || form.skill_years_min.trim() !== ''
    || form.exclude_level_c || form.text_keywords.trim() !== ''
  if (!hasCondition) return '条件を1つ以上指定してください'
  const lo = toNum(form.age_min), hi = toNum(form.age_max)
  // 入れ違えると常に0件になり、原因が分からないまま「通知が来ない」と言われる
  if (lo != null && hi != null && lo > hi) return '年齢の下限が上限を超えています'
  // 年数だけ指定してもどの技術か分からない。実測でスキル年数は69%しか取れていない
  if (form.skill_years_min.trim() !== '' && form.skills.trim() === '') {
    return 'スキルの年数を指定するときは、対象のスキルも入力してください'
  }
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
      age_min: rule.age_min == null ? '' : String(rule.age_min),
      age_max: rule.age_max == null ? '' : String(rule.age_max),
      experience_years_min: rule.experience_years_min == null ? '' : String(rule.experience_years_min),
      skill_years_min: rule.skill_years_min == null ? '' : String(rule.skill_years_min),
      exclude_level_c: rule.exclude_level_c,
      text_keywords: (rule.text_keywords ?? []).join(', '),
      include_unknown: rule.include_unknown,
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

        {/* ── 経験で絞る（2026-10-01 追加）──────────────────────────────────
            現場の要求「共通部品を作った経験と Java開発経験、20代後半〜40代、
            教育が必要な人は難しい」を1本のルールで書けるようにしたもの */}
        <div className="border-t border-gray-100 pt-3 space-y-3">
          <h4 className="text-xs font-semibold text-gray-600">経験で絞る（任意）</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-xs text-gray-500 space-y-1">
              <span>年齢（下限）</span>
              <input className={inputCls} inputMode="numeric" value={form.age_min} placeholder="例: 25"
                onChange={(e) => setForm({ ...form, age_min: e.target.value })} />
            </label>
            <label className="text-xs text-gray-500 space-y-1">
              <span>年齢（上限）</span>
              <input className={inputCls} inputMode="numeric" value={form.age_max} placeholder="例: 49"
                onChange={(e) => setForm({ ...form, age_max: e.target.value })} />
            </label>
            <label className="text-xs text-gray-500 space-y-1">
              <span>経験年数（以上）</span>
              <input className={inputCls} inputMode="numeric" value={form.experience_years_min} placeholder="例: 5"
                onChange={(e) => setForm({ ...form, experience_years_min: e.target.value })} />
            </label>
            <label className="text-xs text-gray-500 space-y-1">
              <span>上のスキルの年数（以上）</span>
              <input className={inputCls} inputMode="numeric" value={form.skill_years_min} placeholder="例: 3"
                onChange={(e) => setForm({ ...form, skill_years_min: e.target.value })} />
            </label>
          </div>
          <label className="text-xs text-gray-500 space-y-1 block">
            <span>経歴本文のキーワード（カンマ区切り・いずれかを含む）</span>
            <input className={inputCls} value={form.text_keywords} placeholder="例: 共通部品, 共通基盤, フレームワーク開発"
              onChange={(e) => setForm({ ...form, text_keywords: e.target.value })} />
          </label>
          <label className="flex items-start gap-2 text-xs text-gray-600">
            <input type="checkbox" className="mt-0.5" checked={form.exclude_level_c}
              onChange={(e) => setForm({ ...form, exclude_level_c: e.target.checked })} />
            <span>
              <b>「従事どまり」の人を除く</b>
              <span className="text-gray-400">
                （議事録・資料作成など、支援作業の記述しかない人。役割の到達レベルがCの印しか
                無い人を外します。印が付くのは全体の約半分なので、印の無い人は除きません）
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-gray-600">
            <input type="checkbox" className="mt-0.5" checked={!form.include_unknown}
              onChange={(e) => setForm({ ...form, include_unknown: !e.target.checked })} />
            <span>
              <b>値が取れていない人材を除く</b>
              <span className="text-gray-400">
                （年齢・経験年数は約98%、スキルの年数は約69%、経歴本文は約76%しか取得できて
                いません。既定では「取れていない＝不明」として通します。ここを ON にすると
                確実に条件を満たす人だけになりますが、取りこぼしが増えます）
              </span>
            </span>
          </label>
        </div>

        <p className="text-[11px] text-gray-400">
          種類の違う条件は指定したものをすべて満たす人材に通知します（AND）。
          ただし<b>スキル欄と本文キーワード欄の中は「いずれか1つ」（OR）</b>です
          （例:「大阪府」＋「Java, C#」＝大阪府で Java か C# の人）。
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
                {/* 経験系の条件も一覧に出す。ここに出ないと「なぜ来ない/来る」が追えない */}
                {(rule.age_min != null || rule.age_max != null) && (
                  <span>年齢: <b className="text-gray-700">
                    {rule.age_min ?? ''}〜{rule.age_max ?? ''}
                  </b></span>
                )}
                {rule.experience_years_min != null && (
                  <span>経験: <b className="text-gray-700">{rule.experience_years_min}年以上</b></span>
                )}
                {rule.skill_years_min != null && (
                  <span>スキル年数: <b className="text-gray-700">{rule.skill_years_min}年以上</b></span>
                )}
                {(rule.text_keywords ?? []).length > 0 && (
                  <span>本文: <b className="text-gray-700">{rule.text_keywords.join(' / ')}</b>のいずれか</span>
                )}
                {rule.exclude_level_c && <span className="text-amber-700">従事どまりを除く</span>}
                {!rule.include_unknown && <span className="text-amber-700">値が不明な人を除く</span>}
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
