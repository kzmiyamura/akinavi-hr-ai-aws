// 通知ルール × 人材のマッチ判定（純関数・match_test.ts でテスト）

export interface NotifyRule {
  id: string
  label: string
  name_keyword: string
  skill_keywords: string[]
  station_keyword: string
  notify_email: string
  enabled: boolean
  data_env: string
}

export interface CandidateLite {
  id: string
  name: string
  skills: string[]
  /** 最寄駅 + 都道府県の連結（raw_profile.nearestStation / prefecture 由来） */
  station: string
  data_env: string
}

/** 表記ゆれ吸収: 小文字化 + ピリオド・空白・中点を除去（イニシャル T.K ≒ TK 対応） */
function norm(s: string): string {
  return s.toLowerCase().replace(/[.\s　・]/g, '')
}

/** 条件が1つも指定されていないルールは何にもマッチしない（全員通知の暴発防止） */
export function ruleHasCondition(rule: NotifyRule): boolean {
  return rule.name_keyword.trim() !== ''
    || rule.skill_keywords.some((k) => k.trim() !== '')
    || rule.station_keyword.trim() !== ''
}

/**
 * ルールに人材が合致するか。指定された条件はすべて満たす必要がある（AND）。
 * skill_keywords 内も AND（全キーワードがスキル集合のいずれかに部分一致）。
 */
export function matchesRule(rule: NotifyRule, cand: CandidateLite): boolean {
  if (!ruleHasCondition(rule)) return false
  if (rule.data_env !== cand.data_env) return false
  if (rule.name_keyword.trim() !== '') {
    if (!norm(cand.name).includes(norm(rule.name_keyword))) return false
  }
  const kws = rule.skill_keywords.map((k) => k.trim()).filter((k) => k !== '')
  if (kws.length > 0) {
    const skills = cand.skills.map(norm)
    for (const kw of kws) {
      const k = norm(kw)
      if (!skills.some((s) => s.includes(k))) return false
    }
  }
  if (rule.station_keyword.trim() !== '') {
    if (!norm(cand.station).includes(norm(rule.station_keyword))) return false
  }
  return true
}
