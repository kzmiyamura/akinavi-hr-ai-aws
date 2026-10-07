/**
 * 人材番号（`candidates.candidate_no`）の表示と入力の解釈。2026-10-08
 *
 * 引けるキーが uuid しか無く、口頭でもメモでも使えなかったので連番を振った。
 * 画面には `AK-000123` の形で出す。桁を固定するのは、読み上げたときに
 * 「えーけーいちにさん」が何桁か分かるようにするため（6桁で100万人まで）。
 *
 * ⚠ **番号は「今その行に付いている番号」であって、人物の恒久IDではない。**
 *   同じ会社からの再送は既存行の UPDATE なので番号は維持されるが、
 *   保持期間（既定7日）を過ぎて行が消えた後に再送されると新しい番号になる。
 *   控えの実測（2026-09-01 以降・8,395人）で「保持を過ぎた再登録」は 171 組＝約2%。
 */

/** 表示用の接頭辞。変えると営業のメモと食い違うので、変えない */
export const CANDIDATE_CODE_PREFIX = 'AK'

/** 桁数。6桁＝999,999 人まで。超えたら桁が増えるだけで壊れない */
const CODE_DIGITS = 6

/** `123` → `AK-000123`。番号が無い行（マイグレーション適用前）は null */
export function formatCandidateNo(no: number | null | undefined): string | null {
  if (no == null || !Number.isFinite(Number(no))) return null
  return `${CANDIDATE_CODE_PREFIX}-${String(Math.trunc(Number(no))).padStart(CODE_DIGITS, '0')}`
}

/**
 * 入力が人材番号かを判定して数値を返す。番号でなければ null（＝氏名として扱う）。
 *
 * 受ける形: `123` / `AK-123` / `ak-000123` / `AK 123` / `１２３`（全角）/ 前後の空白。
 * **DB 側（filter_candidates / count_filter_candidates）と同じ規則**にしてある。
 * 片方だけ直すと「画面は番号検索のつもり・DBは氏名の部分一致」になり、
 * 0件なのか該当なしなのか区別できなくなる。
 */
export function parseCandidateCode(input: string | null | undefined): number | null {
  if (!input) return null
  // 全角数字と全角ハイフンを半角に（メモからの貼り付けで混ざる）
  const half = input.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[－ー−]/g, '-')
  if (!/^\s*(?:[Aa][Kk])?\s*-?\s*[0-9]+\s*$/.test(half)) return null
  const digits = half.replace(/[^0-9]/g, '')
  if (digits === '') return null
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
