import { supabase } from '../supabase'

/**
 * スキル別の希望単価相場（万円）。単価交渉の根拠として人材カードに出す。
 *
 * 今までは人材の希望単価だけが画面に出ていて、それが高いのか安いのかは
 * 営業の感覚に任されていた。同じスキル帯の中央値と並べれば根拠になる。
 *
 * ⚠ 相場は**スキル20人以上**のものだけ（ビュー側で絞っている）。
 *   人数が少ないと1人の極端な希望に引きずられ、相場とは呼べない。
 */
export interface SkillRate {
  skill: string
  people: number
  with_rate: number
  p25: number
  median: number
  p75: number
}

/** 相場表を丸ごと取る。424スキル・1行あたり数十バイトなので軽い。
 *  スキルごとに問い合わせると人材1人あたり何十回も往復するので、まとめて取って使い回す */
export async function fetchSkillRateMarket(): Promise<Map<string, SkillRate>> {
  const { data, error } = await supabase.from('skill_rate_market').select('*')
  if (error) throw new Error(`単価相場の取得に失敗しました: ${error.message}`)
  const m = new Map<string, SkillRate>()
  for (const r of (data ?? []) as SkillRate[]) m.set(r.skill, r)
  return m
}

/**
 * その人の希望単価を、持っているスキルの相場と比べる。
 *
 * どのスキルを基準にするか迷うところだが、**一番高い相場のスキル**を採る。
 * 営業が単価を通すときに持ち出すのは「一番強い武器」だから。
 * 例: Java(70万)とSRE(95万)を持つ人なら SRE で語る。
 *
 * @returns 比較できなければ null（単価が読めない／相場のあるスキルを持っていない）
 */
export function compareToMarket(
  desiredRate: string | null | undefined,
  skills: string[] | null | undefined,
  market: Map<string, SkillRate> | undefined,
): { rate: number; skill: string; median: number; diff: number } | null {
  if (!market || !skills?.length) return null
  const rate = parseRateMan(desiredRate)
  if (rate == null) return null
  let best: SkillRate | null = null
  for (const s of skills) {
    const hit = market.get(s)
    if (hit && (!best || hit.median > best.median)) best = hit
  }
  if (!best) return null
  return { rate, skill: best.skill, median: best.median, diff: rate - best.median }
}

/** 「55～60万」→55 /「７５万円」→75 /「応相談」→null。
 *  SQL 側の parse_rate_man と同じ規則（範囲は下限・全角も拾う）。
 *  **片方だけ直すと画面とDBで食い違う**ので、変えるときは両方直すこと。 */
export function parseRateMan(src: string | null | undefined): number | null {
  if (!src) return null
  const t = String(src)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[～－]/g, (c) => (c === '～' ? '~' : '-'))
    // 「55～60万」は片方にしか「万」が付かない。先に展開する
    .replace(/(\d{2,3})[ 　]*[~〜ー−-][ 　]*(\d{2,3})[ 　]*万/g, '$1万 $2万')
  const nums = [...t.matchAll(/(\d{2,3})[ 　]*万/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 20 && n <= 300)
  return nums.length ? Math.min(...nums) : null
}
