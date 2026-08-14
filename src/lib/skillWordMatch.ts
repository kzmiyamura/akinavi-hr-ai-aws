/**
 * スキル名を「語として」照合するための共通実装。
 *
 * CLAUDE.md §6 の鉄則:「部分一致は使わない」（`JavaScript` が `Java` に、
 * `Shell` が `PowerShell` に一致していた）。マッチング側は SQL の `skill_satisfies`
 * に一本化済みだが、AI校正の絞り込み（app_config.llm_filter_skills）だけ
 * 本文の部分一致が残っていた（2026-08-14 修正）。
 *
 * 同じ判定がワーカー側 scripts/llm_extract/shadow_worker_lib.mjs にもある
 * （node から TS を読めないため二重管理）。**片方だけ直さないこと。**
 * ズレると「AI校正待ち」バッジと実際のキューの中身が食い違う。
 */

/** 語境界とみなさない文字（英数字・`#`・`+`）。skill_satisfies と同じ集合 */
const WORD_CHARS = 'a-zA-Z0-9#+'

/** PostgreSQL 正規表現のメタ文字を1文字ブラケット式で無害化する。
 *  バックスラッシュ／二重引用符を含む名前は表現できないので null。 */
export function pgRegexEscape(s: string): string | null {
  let out = ''
  for (const c of s) {
    if (c === '\\' || c === '"') return null
    if (c === ']') out += '[]]'
    else if ('.^$*+?()[{}|-'.includes(c)) out += `[${c}]`
    else out += c
  }
  return out
}

/** 本文からスキル名を語として拾う PostgreSQL 正規表現（imatch 用）。 */
export function pgSkillWordPattern(skill: string): string | null {
  const esc = pgRegexEscape(skill)
  if (esc === null) return null
  return `(^|[^${WORD_CHARS}])${esc}([^${WORD_CHARS}]|$)`
}

/** PostgREST の or() に渡す条件（skills 列の包含 or 本文の語一致）。
 *  正規表現は括弧・カンマを含むため、値を二重引用符で囲んで構文と切り分ける。 */
export function skillFilterOrTerms(skills: string[]): string[] {
  return skills.flatMap((s) => {
    const pattern = pgSkillWordPattern(s)
    return [
      `skills.cs.${JSON.stringify([s])}`,
      pattern === null
        ? `raw_profile->>text.ilike.*${s}*`
        : `raw_profile->>text.imatch."${pattern}"`,
    ]
  })
}

/** ブラウザ側で本文を照合するときの正規表現（上のパターンと同じ語境界）。 */
export function skillWordRegex(skill: string): RegExp {
  const esc = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^${WORD_CHARS}])${esc}([^${WORD_CHARS}]|$)`, 'i')
}

/** 人材がスキル絞り込みに該当するか。判定はワーカーと同じ二本立て
 *  （skills 列の完全一致 or 本文の語一致）。本文が無ければ skills 列だけで近似する。 */
export function matchesSkillFilter(
  filterSkills: string[],
  candidateSkills: string[] | undefined,
  bodyText: string | null,
): boolean {
  return filterSkills.some((f) => {
    const fl = f.toLowerCase()
    if ((candidateSkills ?? []).some((s) => s.toLowerCase() === fl)) return true
    return bodyText ? skillWordRegex(f).test(bodyText) : false
  })
}
