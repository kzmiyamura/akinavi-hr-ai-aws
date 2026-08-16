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

/** 表記ゆれ吸収: 小文字化 + ピリオド・空白・中点・スラッシュ・ハイフンを除去
 *  （イニシャル T.K ≒ TK、`AS/400` ≒ `AS400` ≒ `AS-400`）。
 *  スラッシュとハイフンは 2026-08-17 に追加。大阪のルールが `AS/400` と `AS400` を
 *  別物として扱っていた */
function norm(s: string): string {
  return s.toLowerCase().replace(/[.\s　・/-]/g, '')
}

/** 条件が1つも指定されていないルールは何にもマッチしない（全員通知の暴発防止） */
export function ruleHasCondition(rule: NotifyRule): boolean {
  return rule.name_keyword.trim() !== ''
    || rule.skill_keywords.some((k) => k.trim() !== '')
    || rule.station_keyword.trim() !== ''
}

/**
 * ルールに人材が合致するか。
 *
 * 種類の違う条件（名前・スキル・最寄駅）は AND＝指定したものをすべて満たす必要がある。
 * **スキルのキーワード同士は OR**（いずれか1つでも持っていればよい）。
 *
 * スキルは 2026-08-17 に AND から OR へ変更した。営業が登録した
 * 「大阪府 / C#, Java, AS/400, AS400」は「大阪でこのどれかができる人」の意図だったが、
 * AND では4つすべてを持つ人が要求され、該当0名のまま通知が1件も出ていなかった
 * （実データで確認: 大阪府の1名は C# と Java を持つが AS400 は持たない）。
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
    const hit = kws.some((kw) => {
      const k = norm(kw)
      return skills.some((s) => s.includes(k))
    })
    if (!hit) return false
  }
  if (rule.station_keyword.trim() !== '') {
    if (!norm(cand.station).includes(norm(rule.station_keyword))) return false
  }
  return true
}
