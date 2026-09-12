import type { Candidate } from '../lib/db/candidates'

/**
 * 受信した元メールの本文（折りたたみ）。
 *
 * 人材一覧の詳細ペインにしか無く、**人材マップ・マッチング・案件詳細から開いた
 * 人材詳細（CandidateDetailPage）では出ていなかった**（2026-09-12 営業から指摘）。
 * 同じ人を見ているのに入った経路で表示が違うのは説明がつかないので、1つに寄せた。
 *
 * 2026-09-03 の要望どおり、商流・備考を確かめる用。表示だけで取得はしない
 * （`fetchCandidateById` が既に raw_profile ごと持ってきている）。
 * 一覧には**絶対に載せない**。本文は平均6KB・500件で3MB になる。
 */
export function OriginalEmailDetails({ candidate }: { candidate: Candidate }) {
  const raw = (candidate.raw_profile ?? {}) as Record<string, unknown>
  const bodyText = (raw.text as string | null) ?? ''
  if (!bodyText.trim()) return null
  const subject = raw.subject as string | null
  const from = raw.from as string | null

  return (
    <details className="mt-4 border border-gray-200 rounded-lg">
      <summary className="px-3 py-2 text-xs font-medium text-gray-500 cursor-pointer select-none hover:bg-gray-50 rounded-lg">
        元メール本文
      </summary>
      <div className="px-3 pb-3 pt-1">
        {subject && <p className="text-xs text-gray-400 mb-1">件名: {subject}</p>}
        {from && <p className="text-xs text-gray-400 mb-2">差出人: {from}</p>}
        <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed bg-gray-50 rounded p-2 max-h-96 overflow-y-auto">
          {bodyText}
        </pre>
      </div>
    </details>
  )
}
