import { Sparkles, AlertTriangle, CheckCircle, ChevronDown } from 'lucide-react'

/**
 * 案件×候補者の推薦所見（AI）。
 *
 * 点数と「スキルが合致しています」だけでは営業が使えない、という指摘で入れた
 * （2026-08-13:「こんな人材じゃないと受けてもらえない、逆にこの経験が絶対に役に立つはず、
 *   みたいな後押しコメントが出ないとこのアプリの意味がない」）。
 *
 * 書き込みは scripts/llm_extract/recommend.mjs（Claude Haiku）だけが行い、
 * submissions.ai_raw.recommendation に入る。根拠（経歴のどの記述か）を必ず併記する。
 */
export interface Recommendation {
  at?: string | null
  model?: string | null
  /** この案件が本当に求めている人物像 */
  required?: string | null
  verdict?: '推せる' | '条件付き' | '見送り' | null
  /** 営業がそのまま使える後押し文 */
  pitch?: string | null
  strengths?: Array<{ point?: string | null; evidence?: string | null }> | null
  gaps?: string[] | null
  confidence?: string | null
}

export function getRecommendation(aiRaw: unknown): Recommendation | null {
  const r = (aiRaw as { recommendation?: unknown } | null | undefined)?.recommendation
  if (!r || typeof r !== 'object') return null
  const rec = r as Recommendation
  return rec.pitch ? rec : null
}

/**
 * 並び替え用の段階。数字が小さいほど上に出す。
 * 「見送り」はAIが明示的に否と判断したもので、未評価（所見なし）より下に沈める。
 * ルール点数は候補出しの内部値で、最終判断はAIの verdict（docs/matching_redesign.md）。
 */
export function verdictTier(aiRaw: unknown): number {
  const v = getRecommendation(aiRaw)?.verdict
  if (v === '推せる') return 0
  if (v === '条件付き') return 1
  if (v === '見送り') return 3
  return 2 // 所見なし（未評価）
}

/** ランキングの並び: verdict 段階 → ルール点数の辞書順 */
export function compareByVerdictThenScore(
  a: { ai_raw: unknown; match_score: number },
  b: { ai_raw: unknown; match_score: number },
): number {
  const t = verdictTier(a.ai_raw) - verdictTier(b.ai_raw)
  return t !== 0 ? t : b.match_score - a.match_score
}

export const VERDICT_STYLE: Record<string, string> = {
  '推せる': 'bg-green-100 text-green-800 border-green-300',
  '条件付き': 'bg-amber-100 text-amber-800 border-amber-300',
  '見送り': 'bg-gray-100 text-gray-600 border-gray-300',
}

export function RecommendationNote({ rec }: { rec: Recommendation }) {
  const strengths = (rec.strengths ?? []).filter((s) => s?.point)
  const gaps = (rec.gaps ?? []).filter(Boolean)
  return (
    <div className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Sparkles size={12} className="text-violet-600 shrink-0" />
        <span className="text-[10px] font-semibold text-violet-700 uppercase tracking-wide">提案所見（AI）</span>
        {rec.verdict && (
          <span className={`text-[10px] font-medium rounded border px-1.5 py-0.5 ${VERDICT_STYLE[rec.verdict] ?? VERDICT_STYLE['条件付き']}`}>
            {rec.verdict}
          </span>
        )}
        {rec.confidence === 'low' && (
          <span className="text-[10px] text-gray-400">確信度：低（内容を確認してから使う）</span>
        )}
      </div>

      {/* 営業がそのまま使える後押し文。ここだけは常に見せる */}
      <p className="text-xs text-gray-800 leading-relaxed">{rec.pitch}</p>

      {/* 根拠は畳む（2026-08-14 指摘「必要な情報以外はアコーディオンでいい」）。
          効く経験は根拠つきで4件前後・足りない点が3件前後あり、5人ぶん並べると
          カードが読めなくなる。件数は summary に出すので畳んだままでも量は分かる。
          「この案件が求める人」は同じ案件なら全員同じ文なので、ここに入れて重複を隠す */}
      {(strengths.length > 0 || gaps.length > 0 || rec.required) && (
        <details className="group rounded border border-violet-200 bg-white/60 overflow-hidden">
          <summary className="flex items-center gap-1 px-2 py-1 text-[10px] text-violet-700 cursor-pointer select-none hover:bg-violet-50 list-none [&::-webkit-details-marker]:hidden">
            <ChevronDown size={12} className="shrink-0 text-violet-400 transition-transform group-open:rotate-180" />
            <span className="font-medium">根拠を見る</span>
            <span className="text-violet-400 font-normal">
              {[
                strengths.length > 0 ? `効く経験 ${strengths.length}件` : null,
                gaps.length > 0 ? `足りない点 ${gaps.length}件` : null,
              ].filter(Boolean).join(' ・ ')}
            </span>
          </summary>
          <div className="px-2 pb-2 pt-1 space-y-1.5">
            {rec.required && (
              <p className="text-xs text-gray-600 leading-relaxed">
                <span className="text-gray-400">この案件が求める人：</span>{rec.required}
              </p>
            )}

            {strengths.length > 0 && (
              <div className="space-y-0.5">
                {strengths.map((s, i) => (
                  <div key={i} className="text-xs text-gray-700 flex gap-1.5">
                    <CheckCircle size={11} className="text-green-600 shrink-0 mt-0.5" />
                    <span className="min-w-0">
                      {s.point}
                      {/* 根拠を出さない断定はしない。経歴のどの記述から言っているかを必ず添える */}
                      {s.evidence && (
                        <span className="block text-[10px] text-gray-400 leading-snug">経歴より：{s.evidence}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {gaps.length > 0 && (
              <div className="space-y-0.5 border-t border-violet-200 pt-1">
                {gaps.map((g, i) => (
                  <div key={i} className="text-xs text-gray-600 flex gap-1.5">
                    <AlertTriangle size={11} className="text-amber-600 shrink-0 mt-0.5" />
                    <span className="min-w-0">{g}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  )
}
