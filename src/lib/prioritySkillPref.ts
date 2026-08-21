/** 人材一覧の「表示優先スキル」の端末別設定（2026-08-21 ユーザー要望）
 *
 *  既定は設定画面の値（`app_config.llm_filter_skills`）。これは常駐AIの解析対象を絞る
 *  全体設定と共有しているため、営業ごとに見たいスキルが違っても切り替えられなかった。
 *  そこで「この端末だけの上書き」を localStorage に持たせる。
 *
 *  サーバーに持たせない理由: 認証が無くユーザーの識別子が無い（ニックネームは自己申告）。
 *  端末に持たせれば app_config を触らずに済み、egress も増えない。
 *
 *  - `skills: null`  … 設定画面の既定に従う（初期状態）
 *  - `skills: []`    … この端末では優先スキルを使わない
 *  - `skills: [...]` … この端末だけの優先スキル
 *  - `enabled`       … 一覧ヘッダーのトグル。false なら絞り込みを外して全人材を表示する
 */
const STORAGE_KEY = 'akinavi.prioritySkills.v1'

export interface PrioritySkillPref {
  /** true = 優先スキルで絞り込む / false = 全人材を表示する */
  enabled: boolean
  /** null = 設定画面の既定を使う / 配列 = この端末だけの優先スキル */
  skills: string[] | null
}

export const DEFAULT_PRIORITY_SKILL_PREF: PrioritySkillPref = { enabled: true, skills: null }

/** 入力を保存できる形に整える（前後空白・空文字・重複を落とす。大小の違いは別物として残す） */
export function normalizePrioritySkills(input: readonly unknown[]): string[] {
  const out: string[] = []
  for (const v of input) {
    const s = String(v ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** 保存済みの値を読む。壊れていれば既定に戻す（画面を落とさない） */
export function readPrioritySkillPref(): PrioritySkillPref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PRIORITY_SKILL_PREF
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_PRIORITY_SKILL_PREF
    const o = parsed as Record<string, unknown>
    return {
      // 旧い形・欠損は「絞り込む」に倒す（既定の挙動を変えない）
      enabled: o.enabled !== false,
      skills: Array.isArray(o.skills) ? normalizePrioritySkills(o.skills) : null,
    }
  } catch {
    return DEFAULT_PRIORITY_SKILL_PREF
  }
}

export function writePrioritySkillPref(pref: PrioritySkillPref): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      enabled: pref.enabled,
      skills: pref.skills === null ? null : normalizePrioritySkills(pref.skills),
    }))
  } catch {
    /* ignore（プライベートブラウズ・容量超過。設定が残らないだけで画面は動く） */
  }
}

/** 実際に一覧の絞り込みへ渡す優先スキル。
 *  絞り込み無し（＝全件）は null で表す。呼び出し側の `prioritySkills` 引数と同じ約束。 */
export function resolvePrioritySkills(
  pref: PrioritySkillPref,
  settingsSkills: string[] | null | undefined,
): string[] | null {
  if (!pref.enabled) return null
  const list = pref.skills ?? settingsSkills ?? null
  return list && list.length > 0 ? list : null
}
