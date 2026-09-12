/** 人材分布マップの「最近絞り込んだスキル」の端末別履歴（2026-09-12 ユーザー要望）
 *
 *  同じスキルを何度も打ち直すのが手間、という話。直近の数件をボタンで出す。
 *
 *  サーバーに持たせない理由は [[prioritySkillPref]] と同じで、認証が無く
 *  ユーザーを識別できないため。端末に持てば egress も増えない。
 *
 *  保存する値は**画面に出したままの表記**。突合だけ大小を無視する
 *  （「Java」と打ったら「Java」と出したい。「java」に化けさせない）。
 */
const STORAGE_KEY = 'akinavi.recentSkillFilters.v1'

/** 覚えておく件数。横1列に収まる範囲にする */
export const RECENT_SKILL_LIMIT = 5

/** 保存できる形に整える。空文字・重複（大小無視）を落とし、新しい順に上限まで */
export function normalizeRecentSkills(input: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of input) {
    const s = String(v ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= RECENT_SKILL_LIMIT) break
  }
  return out
}

/** 新しく使ったスキルを先頭に入れた履歴を返す（既存と同じものは大小を無視して1つに畳む） */
export function pushRecentSkill(current: readonly string[], skill: string): string[] {
  const s = skill.trim()
  if (!s) return normalizeRecentSkills(current)
  return normalizeRecentSkills([s, ...current])
}

/** 保存済みの履歴を読む。壊れていれば空に倒す（画面を落とさない） */
export function readRecentSkills(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? normalizeRecentSkills(parsed) : []
  } catch {
    return []
  }
}

export function writeRecentSkills(skills: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeRecentSkills(skills)))
  } catch {
    /* ignore（プライベートブラウズ・容量超過。履歴が残らないだけで画面は動く） */
  }
}
