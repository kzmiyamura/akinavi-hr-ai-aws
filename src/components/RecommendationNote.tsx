import { Sparkles, AlertTriangle, CheckCircle } from 'lucide-react'

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

const VERDICT_STYLE: Record<string, string> = {
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

      {rec.required && (
        <p className="text-xs text-gray-600 leading-relaxed">
          <span className="text-gray-400">この案件が求める人：</span>{rec.required}
        </p>
      )}

      <p className="text-xs text-gray-800 leading-relaxed">{rec.pitch}</p>

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
  )
}
