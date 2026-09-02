/**
 * 役割の到達レベル（A 主導 / B 担当 / C 従事 / － 裏付けなし）。
 *
 * 定義は docs/ROLE_DEFINITION.md 軸3。判定は inbound-email の `scoreProseRoles` が行い、
 * `raw_profile._roleLevels` に `{ 役割ラベル: 'A'|'B'|'C'|'-' }` で入る。
 *
 * なぜ要るか（2026-09-01 ユーザー指摘「分からずにpmoとか書いて点数上げようとする
 * バカ人材を見抜いて」）:
 *   実データで、大手金融・官公庁のPMO支援（RFP〜ベンダ評価選定）をやった人と、
 *   資格がPowerPoint上級・普通車免許の人が、同じ「PMO」ラベルで同じ点数だった。
 *   世界のどの枠組み（SFIA・ITSS・日本PMO協会・PMI）も役割は「× レベル」で定義する。
 *
 * ⚠ **役割そのものは消さない。** 印を付けて営業に見せる。消すと根拠が確認できない。
 * ⚠ **実測で単価が分かれた6役割にだけ印が付く**（PMO / PM / コンサルタント /
 *    アーキテクト / テックリード / インフラエンジニア）。それ以外は null が返る。
 */
export type RoleLevel = 'A' | 'B' | 'C' | '-'

/** 直近7日・prod 実測の平均希望単価（万円）。ツールチップで根拠として見せる */
const MEASURED_RATE: Record<string, [number, number, number]> = {
  'PMO':                      [97, 76, 66],
  'プロジェクトマネージャー': [106, 85, 77],
  'コンサルタント':           [117, 99, 74],
  'アーキテクト':             [111, 99, 72],
  'テックリード':             [105, 89, 79],
  'インフラエンジニア':       [81, 66, 56],
}

/** 役割ごとの、そのレベルが何を指すか */
const MEANING: Record<string, Record<RoleLevel, string>> = {
  'PMO': {
    A: '全社標準化・RFP・ベンダ評価など、マネジメントの仕組みを主導',
    B: '課題管理・進捗管理・WBSなど、仕組みを回した',
    C: '議事録・資料作成・PC手配など、事務局作業',
    '-': 'PMOと書いてあるが、PMO業務の記述が見当たらない',
  },
  'プロジェクトマネージャー': {
    A: '複数プロジェクトの統括・役員報告',
    B: '予算・要員計画・契約に責任を持った',
    C: '進捗管理と報告どまり',
    '-': 'PMと書いてあるが、予算・要員・契約の記述が見当たらない',
  },
  'コンサルタント': {
    A: '経営・全社・事業戦略の領域',
    B: '提案・RFP・業務改革・評価選定',
    C: '支援・ヒアリングどまり',
    '-': 'コンサルタントと書いてあるが、成果物の記述が見当たらない',
  },
  'アーキテクト': {
    A: '全体最適・技術戦略・標準化',
    B: 'アーキテクチャ・方式設計・非機能',
    C: '設計に関わったという記述のみ',
    '-': 'アーキテクトと書いてあるが、設計の記述が見当たらない',
  },
  'テックリード': {
    A: '技術戦略・技術標準・内製化',
    B: 'コードレビュー・設計レビュー・技術選定',
    C: 'リード・牽引という記述のみ',
    '-': 'テックリードと書いてあるが、技術判断の記述が見当たらない',
  },
  'インフラエンジニア': {
    A: '冗長化・可用性・方式設計',
    B: '構築（Linux / Windows Server / 仮想化）',
    C: '監視・運用どまり',
    '-': 'インフラと書いてあるが、構築の記述が見当たらない',
  },
}

export const ROLE_LEVEL_STYLE: Record<RoleLevel, { mark: string; cls: string }> = {
  A:   { mark: 'A 主導', cls: 'bg-indigo-100 text-indigo-700' },
  B:   { mark: 'B 担当', cls: 'bg-sky-100 text-sky-700' },
  C:   { mark: 'C 従事', cls: 'bg-amber-100 text-amber-800' },
  '-': { mark: '裏付けなし', cls: 'bg-rose-100 text-rose-700' },
}

/** raw_profile._roleLevels からその役割のレベルを読む。判定対象外の役割は null */
export function readRoleLevel(
  rawProfile: Record<string, unknown> | null | undefined,
  role: string | null | undefined,
): RoleLevel | null {
  if (!rawProfile || !role) return null
  const map = rawProfile._roleLevels
  if (!map || typeof map !== 'object') return null
  const v = (map as Record<string, unknown>)[role]
  return v === 'A' || v === 'B' || v === 'C' || v === '-' ? v : null
}

/** バッジのツールチップ。判定の根拠（実測の単価分布）まで出す */
export function roleLevelNote(role: string, level: RoleLevel): string {
  const meaning = MEANING[role]?.[level] ?? ''
  const m = MEASURED_RATE[role]
  const basis = m
    ? `\nこの役割の平均希望単価（直近実測）: A級${m[0]}万 ／ B級${m[1]}万 ／ C級${m[2]}万`
    : ''
  return `${role} の到達レベル: ${ROLE_LEVEL_STYLE[level].mark}\n${meaning}${basis}`
}

/**
 * 希望単価の文字列から「万」単位の最大値を読む。
 * match-batch の parseRateWan と同じ考え方（複数書いてあるときは高い方を採る）。
 */
export function parseRateWan(rate: string | number | null | undefined): number | null {
  if (rate == null) return null
  if (typeof rate === 'number') return Number.isFinite(rate) ? rate : null
  let max: number | null = null
  for (const m of rate.matchAll(/(\d{2,3})\s*万/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && (max == null || n > max)) max = n
  }
  return max
}

/**
 * 到達レベルと希望単価が食い違っていないか。
 * **C級（周辺作業どまり）で高単価を希望している場合だけ**警告する。
 * 落とすのではなく気付かせる（判断は営業がする）。
 *
 * ⚠ 「－ 裏付けなし」は警告しない（2026-09-02 実測で訂正）。
 *   裏付けなし群（PMO 97人）は PM併記64.9%・予算/契約/要員への言及82.5%・
 *   平均希望単価75万で、**C級(67万)より上**だった。
 *   「－」は実力が無いのではなく「その役割としての記述が無い」＝ラベルが当てに
 *   ならないだけ。ここに単価警告を出すと誤報になる。
 *   （当初「裏付けゼロで80万以上の26人＝見抜くべき人」と報告したが言い過ぎだった）
 */
export function rateMismatch(
  level: RoleLevel | null,
  desiredRate: string | number | null | undefined,
): { note: string } | null {
  if (level !== 'C') return null
  const wan = parseRateWan(desiredRate)
  if (wan == null || wan < 80) return null
  return {
    note: `希望${wan}万に対し、経歴の記述は従事レベル（周辺作業）どまりです。`
      + `経歴書の確認をおすすめします。`,
  }
}
