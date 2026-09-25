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
 * ■ 上限が何を守っているか（2026-09-26 実測で見直し）
 *   AI の費用ではない。ワーカーは `claude -p`（Max枠）で動いており実課金は発生しない。
 *
 *   **egress でもない。** 2026-09-23 時点ではここに「Free プラン月5GB が制約」と
 *   書いていたが、実際は Pro プラン（月250GB）で、9/26 時点の請求期間の消費は
 *   2.39GB＝**枠の1%**。経歴書のダウンロードは平均180KB・中央63KB なので、
 *   1日1,000件校正しても月5GB程度にしかならない。egress は制約になっていない。
 *
 *   今ここを縛っているのは **処理時間** だけ。実測で1人あたり約1.3分
 *   （本文のみ。経歴書つきはもっとかかる）。
 *
 * ■ 上げるとどうなるか
 *   ワーカーは上限を24時間に均して配る（`pacedAllowance`）ので、
 *   上限＝1日に配る枠そのもの。9/26 08:00 時点で day=100/300 と
 *   **配分線にぴったり張り付いており、行列が空なのではなく待たされている**。
 *   行列（直近7日・優先スキル絞込あり）は 1,530人、登録は約380人/日。
 *   人材は7日で `candidates_archive_light` に移るので、
 *   間に合わなかった人は二度と校正されない。
 *
 *   なお **ログの `day=N/上限` は人材校正だけの数ではない**。
 *   案件・AI解釈・推薦文も同じカウンタを使う（9/25 は上限300に対し人材校正217件）。
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
