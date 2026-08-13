import { useState } from 'react'
import { Sparkles } from 'lucide-react'

/**
 * 「この項目は常駐AI（Haiku）が書き換えた」ことを画面に出す。
 *
 * 取り込みは regex が先に登録し、そのあとワーカーが LLM で直す二段構えになっている。
 * 直した記録は raw_profile._llm_applied（項目名・モデル・日時）、直す前の値は
 * raw_profile._regex_backup に入っているが、**画面はこれを一切出していなかった**。
 * 案件は prod 8件すべてが LLM 補正済みで、うち2件は必須スキルが AI によって +1 されている。
 * 必須スキルはマッチングのスコアの分母そのものなので、営業が条件を見たときに
 * 「これは誰が書いたのか」が分からないと数字を信用できない（2026-08-13）。
 *
 * スコアの根拠になっている項目は画面に出す、という方針の一部。
 */

export interface LlmApplied {
  at?: string | null
  model?: string | null
  status?: string | null
  fields?: string[] | null
}

export interface LlmChangeRow {
  /** 表示用のラベル（日本語） */
  label: string
  /** 上書き前の値。regex が何も取れていなかったときは null */
  before: string | null
  /** 現在の値。オブジェクト・配列は要約に落とす */
  after: string | null
  /** fields の元表記に付いていた補足（例: "+1件・regexが0件のため補完"） */
  note: string | null
}

const FIELD_LABELS: Record<string, string> = {
  // 人材
  name: '氏名',
  age: '年齢',
  gender: '性別',
  experience_years: '経験年数',
  desired_rate: '希望単価',
  from_company: '所属会社',
  prefecture: '居住地',
  nearestStation: '最寄駅',
  projects: '案件経歴',
  skillYears: 'スキル年数',
  skills: 'スキル',
  // 案件
  client: 'クライアント',
  role_summary: '業務内容',
  required_skills: '必須スキル',
  work_location: '勤務地',
  remote_policy: 'リモート可否',
  budget_max: '単価上限',
  contract_type: '契約形態',
}

/** 値を1行に収まる文字列にする。オブジェクト・配列は件数の要約にする */
function summarize(v: unknown): string | null {
  if (v == null || v === '') return null
  if (Array.isArray(v)) return v.length === 0 ? null : `${v.length}件`
  if (typeof v === 'object') {
    const n = Object.keys(v as Record<string, unknown>).length
    return n === 0 ? null : `${n}件`
  }
  const s = String(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/**
 * _llm_applied.fields を画面に出せる行に変換する。
 *
 * fields の要素は素のキー（"age"）だけでなく
 * "skills(+5)" / "required_skills(+1件・regexが0件のため補完）" のように
 * 補足が付いた表記も混ざる（ワーカー側が人間向けに書いている）。
 */
export function describeLlmChanges(
  applied: LlmApplied | null | undefined,
  backup: Record<string, unknown> | null | undefined,
  current: Record<string, unknown>,
): LlmChangeRow[] {
  const fields = applied?.fields
  if (!Array.isArray(fields) || fields.length === 0) return []
  const rows: LlmChangeRow[] = []
  for (const raw of fields) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    // "required_skills(+1件・…）" → キー "required_skills" と補足 "+1件・…"
    const m = raw.match(/^([^(（]+)[(（](.*?)[)）]?$/)
    const key = (m ? m[1] : raw).trim()
    const note = m ? m[2].trim() || null : null
    rows.push({
      label: FIELD_LABELS[key] ?? key,
      before: summarize(backup?.[key]),
      after: summarize(current[key]),
      note,
    })
  }
  return rows
}

function formatAt(at: string | null | undefined): string | null {
  if (!at) return null
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * AI が書き換えた項目の一覧。何も書き換えていなければ何も描画しない。
 * 既定は畳んだ状態で、件数だけ出す（一覧の情報量を増やしすぎないため）。
 */
export function AiAppliedNote({ applied, backup, current }: {
  applied: LlmApplied | null | undefined
  backup: Record<string, unknown> | null | undefined
  current: Record<string, unknown>
}) {
  const [open, setOpen] = useState(false)
  const rows = describeLlmChanges(applied, backup, current)
  if (rows.length === 0) return null
  const at = formatAt(applied?.at)
  const model = applied?.model ?? 'AI'

  return (
    <div className="mt-2 rounded border border-violet-200 bg-violet-50 p-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-violet-700 hover:text-violet-900"
      >
        <Sparkles size={12} />
        <span className="font-medium">AIが補正した項目 {rows.length}件</span>
        <span className="text-violet-500">
          （{model}{at ? `・${at}` : ''}）
        </span>
        <span className="text-violet-400">{open ? '閉じる' : '内訳'}</span>
      </button>
      {open && (
        <table className="mt-1 w-full">
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="align-top">
                <td className="py-0.5 pr-2 whitespace-nowrap text-violet-700">{r.label}</td>
                <td className="py-0.5 text-gray-600">
                  {r.before != null
                    ? <><span className="text-gray-400 line-through">{r.before}</span>{' → '}{r.after ?? '—'}</>
                    : <><span className="text-gray-400">取得できず</span>{' → '}{r.after ?? '—'}</>}
                  {r.note && <span className="ml-1 text-gray-400">({r.note})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
