/**
 * 役割を「職種」と「経験」の2軸に分けて見せるための変換。
 *
 * なぜ要るか（2026-10-01 ユーザー指摘「役割がプロジェクトリーダーじゃ、
 * 主に何の人かわからない」）:
 *   `roles` はスコア降順の1本の配列で、先頭が主役割として強調表示される。
 *   ところが PM / PL / PMO のような**管理の立場**は「何の人か」を答えない。
 *   同じ PL でも Java の PL とインフラの PL はまったく別の人材で、
 *   営業はそこを見て案件に当てている。
 *
 *   prod 4,204人の実測（2026-10-01）:
 *     主役割が管理系        1,713人（41%）
 *       うち技術系の役割も持つ 1,404人（82%）… 分ければ職種が読める
 *       技術系がゼロ            309人（全体の7.3%）… 分けても職種は出ない
 *
 * ⚠ **`roles` の中身と並び順は変えない。** マッチングの加減点は `roles[0]` を見ており
 *   （`match-batch` の役割加減点・同一+15/同系統+6/系統違い-9）、ここを触ると
 *   画面の見た目と保存済みスコアがズレる。これは表示だけの変換。
 *   関連: docs/ROLE_DEFINITION.md / src/lib/roleLevel.ts
 */

/**
 * 「立場」であって「何の人か」を答えない役割。
 *
 * コンサルタントとアーキテクトは**職種側に残す**。作用対象（経営／設計）が
 * ラベル自体に入っていて、それだけで何の人かが読めるため。
 */
export const LEADERSHIP_ROLES = [
  'プロジェクトマネージャー',
  'プロジェクトリーダー',
  'PMO',
  'プロダクトマネージャー',
  'スクラムマスター',
  'ディレクター',
  'テックリード',
] as const

/** 経験欄に出すときの表記。「〜だった人」ではなく「〜の経験がある」と読ませる */
const LEADERSHIP_LABEL: Record<string, string> = {
  'プロジェクトマネージャー': 'PM経験',
  'プロジェクトリーダー': 'リーダー経験',
  'PMO': 'PMO経験',
  'プロダクトマネージャー': 'PdM経験',
  'スクラムマスター': 'スクラムマスター経験',
  'ディレクター': 'ディレクター経験',
  'テックリード': 'テックリード経験',
}

const LEADERSHIP_SET: ReadonlySet<string> = new Set(LEADERSHIP_ROLES)

export function isLeadershipRole(role: string): boolean {
  return LEADERSHIP_SET.has(role)
}

/** 経験欄の表記を返す。対象外の役割はそのまま返す */
export function leadershipLabel(role: string): string {
  return LEADERSHIP_LABEL[role] ?? role
}

export interface SplitRoles {
  /** 職種（何の人か）。元の並び順＝スコア降順を保つので先頭が主職種 */
  jobs: string[]
  /** 立場の経験（PM / リーダー / PMO 等）。元の並び順を保つ */
  leadership: string[]
}

/**
 * `roles` を職種と経験に分ける。並び順は元のまま（スコア降順）。
 * null / 空配列でも必ず両方の配列を返す（呼ぶ側に分岐を作らせない）。
 */
export function splitRoles(roles: readonly string[] | null | undefined): SplitRoles {
  const jobs: string[] = []
  const leadership: string[] = []
  for (const r of roles ?? []) {
    if (!r) continue
    if (isLeadershipRole(r)) leadership.push(r)
    else jobs.push(r)
  }
  return { jobs, leadership }
}

/**
 * 職種の代表を1つ返す。無ければ null。
 * 「経験は取れているのに職種が取れていない」人（実測309人）を呼ぶ側が
 * 区別できるよう、空文字ではなく null を返す。
 */
export function mainJob(roles: readonly string[] | null | undefined): string | null {
  return splitRoles(roles).jobs[0] ?? null
}
