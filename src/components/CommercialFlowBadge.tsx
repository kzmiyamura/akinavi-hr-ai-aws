/**
 * 商流バッジ。「うちから紹介で客先常駐できるか」を色で一目化する。
 *
 * 自社   = 直接紹介できる（緑）
 * 1社先  = 1社挟む（黄）
 * 2社先〜= 深いので警戒（赤）
 *
 * 人材詳細（CandidatePage）とマッチング（MatchingPage）の両方で使う。
 * 2026-09-03 の営業要望「派遣で来てもらう案件では所属が個人事業主だったり
 * 一社先だったりするので、AI判定だけでなく元メールを見て確認したい」に対し、
 * まずカード上で商流が一目で分かるようにするためマッチング側にも出した。
 */
export function commercialFlowClass(flow: string): string {
  const num = Number(flow.match(/^(\d+)社先/)?.[1] ?? 0)
  if (flow === '自社') return 'bg-emerald-100 text-emerald-800 font-medium'
  return num >= 2
    ? 'bg-red-100 text-red-700 font-medium'
    : 'bg-amber-100 text-amber-800 font-medium'
}

export function CommercialFlowBadge({
  flow,
  size = 'sm',
}: {
  flow: string | null | undefined
  /** sm=人材詳細（text-xs） / xs=マッチングカード（text-[10px]） */
  size?: 'sm' | 'xs'
}) {
  if (!flow?.trim()) return null
  const font = size === 'xs' ? 'text-[10px]' : 'text-xs'
  return (
    <span
      className={`${font} rounded px-1.5 py-0.5 ${commercialFlowClass(flow)}`}
      title="商流位置（自社=直接紹介可 / N社先=N社を挟む）"
    >
      {flow}
    </span>
  )
}
