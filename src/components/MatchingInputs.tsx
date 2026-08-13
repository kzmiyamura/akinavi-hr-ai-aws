import { useQuery } from '@tanstack/react-query'
import type { Project } from '../lib/db/projects'
import type { ScoringWeights } from '../lib/db/candidates'
import { calcProjectWeights, DEFAULT_SCORING_WEIGHTS } from '../lib/db/candidates'
import { fetchGenericSkills } from '../lib/db/skillMatch'
import { getAiInterpretation } from '../lib/projectInterpretation'

/**
 * この案件の採点に実際に使われるウェイトを返す。
 *
 * 保存済み（raw_data.matchWeights）があればそれが正。無ければ案件内容から算出する。
 * MatchingPage の初期化と同じ順序でなければ、画面の配点表示と実際の順位がズレる。
 */
export function resolveScoringWeights(p: Project): ScoringWeights {
  const saved = (p.raw_data as Record<string, unknown> | null)?.matchWeights as Partial<ScoringWeights> | undefined
  if (saved && typeof saved === 'object' && saved.skill != null) {
    return {
      skill: saved.skill,
      exp: saved.exp ?? DEFAULT_SCORING_WEIGHTS.exp,
      rate: saved.rate ?? DEFAULT_SCORING_WEIGHTS.rate,
      location: saved.location ?? DEFAULT_SCORING_WEIGHTS.location,
      remote: saved.remote ?? DEFAULT_SCORING_WEIGHTS.remote,
    }
  }
  return calcProjectWeights(p)
}

/** 案件が採点に使える値を持っているか（持っていない軸は全候補者が横並びになる） */
function axisValues(p: Project) {
  return [
    { axis: 'スキル', key: 'skill' as const, ok: ((p.required_skills as string[] | null) ?? []).length > 0 },
    { axis: '勤務地', key: 'location' as const, ok: Boolean(p.work_prefecture) },
    { axis: '単価', key: 'rate' as const, ok: p.budget_max != null },
    { axis: '経験', key: 'exp' as const, ok: p.required_experience_years != null },
    { axis: 'リモート', key: 'remote' as const, ok: Boolean(p.remote_policy) },
  ]
}

/**
 * 案件ごとの配点を1行で出す。
 *
 * 人材モードは1人に対して案件が並ぶ画面で、案件ごとに配点が違う。
 * 表を案件の数だけ出すと画面が潰れるので、ここでは軸と点数だけを並べ、
 * 値が取れていない軸（＝その点数が全候補者に一律で入り、順位に効かない）を
 * 赤で出す。詳しい内訳は案件画面・マッチング画面の案件モードで見る。
 */
export function MatchingWeightsLine({ project: p, weights }: {
  project: Project
  weights?: ScoringWeights
}) {
  const w = weights ?? resolveScoringWeights(p)
  const skillWeights = p.skill_weights && Object.keys(p.skill_weights).length > 0
    ? Object.entries(p.skill_weights).sort((a, b) => b[1] - a[1])
    : []

  return (
    <div className="mt-1 space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
        <span className="text-gray-400">配点</span>
        {axisValues(p).map(({ axis, key, ok }) => (
          <span key={axis} className={ok ? 'text-gray-500' : 'text-red-500'}>
            {axis}
            <span className="font-medium">{w[key]}</span>
            {!ok && <span className="ml-0.5">未取得</span>}
          </span>
        ))}
        {p.contract_type === '派遣' && <span className="text-orange-600">派遣免許で絞込</span>}
      </div>
      {skillWeights.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11px]">
          <span className="text-gray-400">スキルの重み</span>
          {skillWeights.map(([skill, weight]) => (
            <span key={skill} className={weight >= 4 ? 'text-green-700 font-medium' : 'text-gray-500'}>
              {skill}<span className="opacity-60">×{weight}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * この案件がマッチングに持ち込む条件を、配点の軸ごとに表示する。
 *
 * 案件メール・手入力から何を取れて何を取れなかったかが画面から分からず、
 * 「勤務地の配点が実は死んでいる」といった状態に気づけなかったため、
 * 採点に使う値そのもの（正規化後）と重みを並べて可視化する。
 *
 * 案件画面・マッチング画面の両方から使う。片方だけに出すと、
 * 順位を見ている画面で「なぜこの順なのか」が分からない（2026-08-13 指摘）。
 */
export function MatchingInputs({ project: p, requiredSkillCount, niceCount, weights, compact }: {
  project: Project
  requiredSkillCount: number
  niceCount: number
  /** マッチング画面で調整中のウェイト。未指定なら案件から解決する */
  weights?: ScoringWeights
  /** マッチング画面のように既に案件サマリーが出ている場所で、余白を詰める */
  compact?: boolean
}) {
  // 「誰でも持っているスキル」は必須に入っていても絞り込みに効かない。
  // どれがそれなのかを画面で分かるようにする（2026-08-13）
  const { data: genericSkills } = useQuery({
    queryKey: ['generic-skills'],
    queryFn: fetchGenericSkills,
    staleTime: 30 * 60_000,
  })
  const w = weights ?? resolveScoringWeights(p)
  const required = ((p.required_skills as string[] | null) ?? [])
  const genericInProject = genericSkills
    ? required.filter((s) => genericSkills.has(s.toLowerCase().trim()))
    : []
  // 全部が汎用なら SQL 側も絞り込みを効かせない（候補が空になるため）
  const genericIsActive = genericInProject.length > 0 && genericInProject.length < required.length
  const rows: Array<{ axis: string; weight: number | null; value: string | null; note?: string }> = [
    {
      axis: '必須スキル', weight: w.skill,
      value: requiredSkillCount > 0 ? `${requiredSkillCount}件を候補者スキルと照合` : null,
      note: requiredSkillCount === 0
        ? '全候補者が一律の点になり、絞り込みが効きません'
        : genericIsActive
          ? `「${genericInProject.join('・')}」は人材の4割超が該当するため、これだけ合致する人は候補に入れません（点数には従来どおり加算）`
          : p.skill_weights
            ? undefined   // 重みは下に一覧で出す
            : '全スキルが同じ重み。工程語だけ一致した候補者も満点になります',
    },
    {
      axis: '勤務地', weight: w.location,
      value: p.work_prefecture,
      note: p.work_prefecture
        ? `表記「${p.work_location ?? '—'}」から判定。同一県=満点／同一地方=半分`
        : `「${p.work_location ?? '未入力'}」から都道府県を特定できず、全候補者が横並びになります`,
    },
    {
      axis: '単価', weight: w.rate,
      value: p.budget_max != null ? `上限 ${p.budget_max}万円` : null,
      note: p.budget_max != null ? '希望単価が上限以内なら満点' : '単価差が採点されません',
    },
    {
      axis: '経験年数', weight: w.exp,
      value: p.required_experience_years != null ? `${p.required_experience_years}年以上を要求` : null,
      note: p.required_experience_years != null
        ? '要求年数を満たすかで採点'
        : '要求年数の記載なし。候補者の年数だけで採点（10年以上が満点）',
    },
    {
      axis: 'リモート', weight: w.remote,
      value: p.remote_policy,
      note: p.remote_policy ? undefined : 'フルリモート希望の候補者を減点できません',
    },
    {
      axis: '派遣許可', weight: null,
      value: p.contract_type === '派遣' ? '派遣免許を持つ会社の人材に限定' : null,
      note: p.contract_type === '派遣' ? undefined : '限定しない',
    },
  ]

  return (
    <div className={`rounded border border-gray-200 bg-gray-50 p-2 space-y-1 ${compact ? '' : 'mt-2'}`}>
      <div className="text-xs font-medium text-gray-600">マッチングに使う条件</div>
      <table className="w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.axis} className="align-top">
              <td className="py-0.5 pr-2 text-gray-500 whitespace-nowrap w-20">{r.axis}</td>
              <td className="py-0.5 pr-2 text-gray-400 whitespace-nowrap w-12">
                {r.weight != null ? `${r.weight}点` : '絞込'}
              </td>
              <td className="py-0.5">
                {r.value
                  ? <span className="text-gray-700">{r.value}</span>
                  : <span className="text-red-500 font-medium">未取得</span>}
                {r.note && <div className="text-gray-400 leading-snug">{r.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.skill_weights && Object.keys(p.skill_weights).length > 0 && (
        <div className="border-t border-gray-200 pt-1 space-y-0.5">
          <div className="text-xs text-gray-500">
            スキルの重み（言語ほど重い・年数指定と記載順で加点）
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(p.skill_weights)
              .sort((a, b) => b[1] - a[1])
              .map(([skill, weight]) => (
                <span
                  key={skill}
                  className={`text-xs rounded px-1.5 py-0.5 border ${
                    weight >= 4 ? 'bg-green-100 border-green-300 text-green-800 font-medium'
                    : weight >= 2 ? 'bg-white border-gray-300 text-gray-600'
                    : 'bg-white border-gray-200 text-gray-400'
                  }`}
                >
                  {skill} <span className="opacity-70">×{weight}</span>
                </span>
              ))}
          </div>
        </div>
      )}
      {niceCount > 0 && (
        <div className="text-xs text-gray-500 border-t border-gray-200 pt-1">
          尚可スキル{niceCount}件は必須スキルの点（{w.skill}点）を最大 +10% 底上げします。
          <span className="text-gray-400">必須の分母は増えないので、満たさなくても減点にはなりません</span>
          {(() => {
            const aiCount = getAiInterpretation(p.raw_data)?.relatedSkills?.length ?? 0
            return aiCount > 0
              ? <span className="block text-violet-500">うち{aiCount}件はAIが業務内容から解釈した関連スキル（点線バッジ）。明記されたスキルと同じ尚可扱いです</span>
              : null
          })()}
        </div>
      )}
    </div>
  )
}
