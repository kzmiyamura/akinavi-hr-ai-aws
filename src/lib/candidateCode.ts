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

// ───────────────────────────────────────────────────────────────────────────
// 通知メールから1人を開くためのリンク（2026-10-10）
//
// 通知メールは氏名と最寄駅しか書いていなかったので、受け取った営業は
// アプリを開く → 人材タブ → 絞り込みに氏名を打つ、という手順を踏んでいた。
// イニシャル氏名は prod 実測で同名10件超が52種・最大35件あるので、
// **打ち直しても本人に辿り着けない**ことがある。メール側にリンクを入れる。
//
// リンクは `?c=<uuid>` を基本にする（送信時点の行を一意に指す）。
// `?c=AK-000123` も受ける：口頭・チャットで番号だけ共有されたときに使える。
// ⚠ 番号は行の番号であって人物の恒久IDではない（上の注意書きを参照）。
// ───────────────────────────────────────────────────────────────────────────

/** リンクのクエリ名。短いのは携帯メールで折り返されにくくするため */
export const CANDIDATE_LINK_PARAM = 'c'

/** uuid v4 形式。ハイフン付きの36文字だけを id と見なす */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CandidateLinkTarget =
  | { kind: 'id'; id: string }
  | { kind: 'no'; no: number }

/**
 * `?c=` の値を解釈する。uuid ならその行、`AK-000123` なら番号、それ以外は null。
 *
 * メールソフトが末尾に `.` や `)` を足して壊すことがあるので、
 * 判定に通らなかったものは**黙って無視する**（人材タブを普通に開く）。
 */
export function parseCandidateLinkParam(raw: string | null | undefined): CandidateLinkTarget | null {
  if (!raw) return null
  const v = raw.trim()
  if (UUID_RE.test(v)) return { kind: 'id', id: v.toLowerCase() }
  const no = parseCandidateCode(v)
  return no == null ? null : { kind: 'no', no }
}

/**
 * 通知メールに入れるリンク。`base` は末尾スラッシュ有無どちらでも受ける。
 *
 * ⚠ **氏名やメールアドレスを URL に入れないこと。** 受信側のメールソフトや
 *   プロキシに URL ごと残る。入れるのは uuid と番号だけにする。
 */
export function candidateLinkUrl(base: string, idOrCode: string): string {
  const root = base.replace(/\/+$/, '')
  return `${root}/?${CANDIDATE_LINK_PARAM}=${encodeURIComponent(idOrCode)}`
}
