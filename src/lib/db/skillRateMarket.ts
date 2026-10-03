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

// fetchSkillRateMarket（スキル単位だけを取る版）は fetchRateMarket に置き換えた。
// 経験年数を無視した相場比較が画面で誤解を生んだため（下の compareToMarket を参照）。

/** 経験帯。**SQL 側の exp_band() と同じ切り方**。片方だけ変えるとキーが食い違う */
export type ExpBand = '0-2' | '3-5' | '6-10' | '11-15' | '16+'

export function expBand(years: number | null | undefined): ExpBand | null {
  if (years == null || !Number.isFinite(years)) return null
  if (years < 3) return '0-2'
  if (years < 6) return '3-5'
  if (years < 11) return '6-10'
  if (years < 16) return '11-15'
  return '16+'
}

export const EXP_BAND_LABEL: Record<ExpBand, string> = {
  '0-2': '経験0〜2年',
  '3-5': '経験3〜5年',
  '6-10': '経験6〜10年',
  '11-15': '経験11〜15年',
  '16+': '経験16年以上',
}

export interface SkillExpRate extends SkillRate {
  exp_band: ExpBand
}

export interface ExpRate {
  exp_band: ExpBand
  people: number
  with_rate: number
  p25: number
  median: number
  p75: number
}

/** 相場の3つの表をまとめて持つ。画面は人材1人ごとに引き直さない */
export interface RateMarket {
  /** スキル単位（経験を無視した従来の相場。最後の受け皿） */
  bySkill: Map<string, SkillRate>
  /** スキル×経験帯（第一基準）。キーは `${skill}${band}` */
  bySkillExp: Map<string, SkillExpRate>
  /** 経験帯だけ（スキル×帯が薄いときの受け皿） */
  byExp: Map<ExpBand, ExpRate>
}

const skillExpKey = (skill: string, band: ExpBand) => `${skill}${band}`

/**
 * 相場表を丸ごと取る。スキル×帯は1,427セットあるが1行数十バイトなので軽い。
 *
 * ⚠ **経験帯の2つのビューは「無くても動く」ことを保証する。**
 *   `20261003_rate_market_by_experience.sql` を流す前にフロントが本番に出ると、
 *   ビューが存在せず PostgREST がエラーを返す。ここで throw すると
 *   **今まで出ていたスキル単位の相場バッジまで消える**（デプロイ順で既存機能が壊れる）。
 *   新しい2本は空として扱い、compareToMarket の第3段（スキル単位）へ落とす。
 *   スキル単位のビューは以前から本番にあるので、そちらの失敗だけは隠さない。
 */
export async function fetchRateMarket(): Promise<RateMarket> {
  const [a, b, c] = await Promise.all([
    supabase.from('skill_rate_market').select('*'),
    supabase.from('skill_rate_market_by_exp').select('*'),
    supabase.from('exp_rate_market').select('*'),
  ])
  if (a.error) throw new Error(`単価相場の取得に失敗しました: ${a.error.message}`)
  for (const [r, view] of [[b, 'skill_rate_market_by_exp'], [c, 'exp_rate_market']] as const) {
    if (r.error) {
      console.warn(
        `[rate-market] ${view} を読めませんでした（マイグレーション未適用の可能性）。` +
        `スキル単位の相場だけで表示します: ${r.error.message}`,
      )
    }
  }
  const bySkill = new Map<string, SkillRate>()
  for (const r of (a.data ?? []) as SkillRate[]) bySkill.set(r.skill, r)
  const bySkillExp = new Map<string, SkillExpRate>()
  for (const r of (b.data ?? []) as SkillExpRate[]) bySkillExp.set(skillExpKey(r.skill, r.exp_band), r)
  const byExp = new Map<ExpBand, ExpRate>()
  for (const r of (c.data ?? []) as ExpRate[]) byExp.set(r.exp_band, r)
  return { bySkill, bySkillExp, byExp }
}

/** 相場比較の結果。**どれを基準にしたかを必ず持たせる**（画面に根拠を出すため） */
export interface MarketComparison {
  rate: number
  median: number
  p25: number
  p75: number
  diff: number
  /** 比較の基準 */
  basis: 'skill-exp' | 'exp' | 'skill'
  /** 基準にしたスキル（basis が 'exp' のときは null） */
  skill: string | null
  /** 基準にした経験帯（basis が 'skill' のときは null） */
  band: ExpBand | null
  /** その相場の母数（少ないほど弱い根拠） */
  people: number
  /** 25〜75% の中に入っているか。入っていれば「高い／低い」と言うべきではない */
  withinQuartiles: boolean
}

/**
 * その人の希望単価を相場と比べる。
 *
 * ## ⚠ 経験年数を無視して比べてはいけない（2026-10-03 指摘）
 *
 * 23歳・経験ほぼ無しの人材（VMware・希望50万）に「相場75万（VMware）-25」と出ていた。
 * 相場がスキル単位しか無く、**20年選手の中央値**と比べていたため。
 * 実測では VMware 0〜2年の中央値は **57万**（25〜75% は46〜60万）で、
 * 50万は -7万＝ほぼ相場どおりだった。若手が安く見えるのは当たり前で、
 * 「-25」は営業の判断を誤らせる。
 *
 * ## 基準の選び方
 *
 * 1. **スキル×経験帯**（20人以上あるセットだけ。1,427セットある）… これが正
 * 2. 経験帯だけ … そのスキルの帯が薄いとき
 * 3. スキル単位 … 経験年数が分からないとき（従来の挙動）
 *
 * スキルは**一番相場が高いもの**を採る。営業が単価を通すときに持ち出すのは
 * 「一番強い武器」だから。例: Java(70万)とSRE(95万)なら SRE で語る。
 * ただし比較する帯は本人の経験帯で固定する（武器だけ借りて年次は盛らない）。
 *
 * @returns 比較できなければ null（単価が読めない／当てはまる相場が無い）
 */
export function compareToMarket(
  desiredRate: string | null | undefined,
  skills: string[] | null | undefined,
  experienceYears: number | null | undefined,
  market: RateMarket | undefined,
): MarketComparison | null {
  if (!market) return null
  const rate = parseRateMan(desiredRate)
  if (rate == null) return null
  const band = expBand(experienceYears)
  const list = skills ?? []

  const build = (
    basis: MarketComparison['basis'],
    skill: string | null,
    b: ExpBand | null,
    src: { median: number; p25: number; p75: number; with_rate: number },
  ): MarketComparison => ({
    rate,
    median: src.median,
    p25: src.p25,
    p75: src.p75,
    diff: rate - src.median,
    basis,
    skill,
    band: b,
    people: src.with_rate,
    withinQuartiles: rate >= src.p25 && rate <= src.p75,
  })

  // 1. スキル×経験帯。本人の帯に固定したうえで、一番相場が高いスキルを採る
  if (band) {
    let best: SkillExpRate | null = null
    for (const s of list) {
      const hit = market.bySkillExp.get(skillExpKey(s, band))
      if (hit && (!best || hit.median > best.median)) best = hit
    }
    if (best) return build('skill-exp', best.skill, band, best)

    // 2. そのスキルの帯が薄い。帯だけの相場に落とす
    const byExp = market.byExp.get(band)
    if (byExp) return build('exp', null, band, byExp)
  }

  // 3. 経験年数が分からない。従来どおりスキル単位（根拠は弱いと画面に出す）
  let bestSkill: SkillRate | null = null
  for (const s of list) {
    const hit = market.bySkill.get(s)
    if (hit && (!bestSkill || hit.median > bestSkill.median)) bestSkill = hit
  }
  if (bestSkill) return build('skill', bestSkill.skill, null, bestSkill)
  return null
}

/** 画面に出す1行。**何を基準にしたかを必ず含める**（根拠の見えない数字は誤解を生む） */
export function marketLabel(cmp: MarketComparison): string {
  if (cmp.basis === 'skill-exp') return `相場${cmp.median}万（${cmp.skill}・${EXP_BAND_LABEL[cmp.band!]}）`
  if (cmp.basis === 'exp') return `相場${cmp.median}万（${EXP_BAND_LABEL[cmp.band!]}・全スキル）`
  return `相場${cmp.median}万（${cmp.skill}・経験不明）`
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
