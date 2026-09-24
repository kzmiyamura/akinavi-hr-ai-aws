import { supabase } from '../supabase'

/**
 * 常駐AI（AI校正ワーカー）の設定。`app_config` に置く。
 *
 * ■ 画面から変えられる意味
 *   ワーカーは**毎サイクル（約5分）この値を読み直す**ので、
 *   保存すれば pm2 の再起動なしでその場で効く
 *   （`scripts/llm_extract/shadow_worker.mjs` の `cycle()` が `maxPerDay()` を呼ぶ）。
 *   これまでは SQL を流さないと変えられなかった。
 *
 * ■ 上限が何を守っているか（2026-09-23 実測）
 *   AI の費用ではない。ワーカーは `claude -p`（Max枠）で動いており実課金は発生しない。
 *   実際に効く制約は **Supabase Storage の egress**。ワーカーは経歴書を
 *   Storage からダウンロードする（実測 平均180KB・中央63KB）。Free プランは月5GB。
 *   300件/日なら、未校正で経歴書を持つ人の山（実測648ファイル＝114MB）を
 *   4〜5日で消化できる規模。
 *
 * ■ 上げるとどうなるか
 *   処理が追いつかない日ほど効く。9/18 は登録1,357件に対し校正289件(21%)で、
 *   経歴書を持ったまま未校正が639人いた。
 *   ただし1件1〜3分かかるので、時間の方が先に尽きる可能性がある。
 *   上げたら Egress と実処理件数を見ること。
 */
export interface ShadowWorkerSettings {
  /** 1日に AI校正する人数の上限。ワーカーは24時間に均して消化する */
  maxPerDay: number
}

/** ワーカー側の既定値（`MAX_PER_DAY_DEFAULT`）と揃えること */
export const SHADOW_WORKER_DEFAULTS: ShadowWorkerSettings = {
  maxPerDay: 100,
}

/** ワーカーが受け付ける範囲（`maxPerDay()` の判定と同じ）。
 *  ここを超える値を保存すると**ワーカーが黙って既定値に落とす**ので、
 *  画面側で先に弾いて「保存したのに効かない」を防ぐ。 */
export const SHADOW_MAX_PER_DAY_LIMIT = 5000

const KEY = 'shadow_max_per_day'

/** 保存形式のゆらぎを吸収する。
 *  値は jsonb で、数値 `300` でも文字列 `"300"` でも入りうる
 *  （画面・SQL・手作業で書き方が違う）。ワーカーも同じように2回まで解く。 */
function parseValue(raw: unknown): number | null {
  let v: unknown = raw
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= SHADOW_MAX_PER_DAY_LIMIT ? Math.floor(n) : null
}

export async function getShadowWorkerSettings(): Promise<ShadowWorkerSettings> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', KEY)
    .maybeSingle()
  return { maxPerDay: parseValue(data?.value) ?? SHADOW_WORKER_DEFAULTS.maxPerDay }
}

export async function saveShadowWorkerSettings(settings: ShadowWorkerSettings): Promise<void> {
  const n = Math.floor(settings.maxPerDay)
  if (!Number.isFinite(n) || n <= 0 || n > SHADOW_MAX_PER_DAY_LIMIT) {
    throw new Error(`1日の上限は 1〜${SHADOW_MAX_PER_DAY_LIMIT} で指定してください`)
  }
  // jsonb 列なので数値のまま入れる。文字列で入れても読めるが、
  // SQL から見たときに型が揃っている方が混乱しない
  const { error } = await supabase
    .from('app_config')
    .upsert([{ key: KEY, value: n }], { onConflict: 'key' })
  if (error) throw new Error(`AI校正の上限保存に失敗しました: ${error.message}`)
}
