/**
 * ルールベーススコアリング（match-batch/index.ts と同一ロジック）
 * フロント JS 側で全候補者をスコアリング・ソートし、上位 N 人だけを
 * AI 採点のために Edge Function へ送ることで通信量を削減する。
 */

export interface CandidateForScore {
  id: string
  skills: string[]
  experienceYears: number | null
  desiredRate: string | null
  prefecture?: string | null
  remoteAvailable?: boolean | null
}

export interface ProjectForScore {
  requiredSkills?: string[]
  niceToHaveSkills?: string[]
  budgetMin?: number | null
  budgetMax?: number | null
  workLocation?: string | null
  // 正規化済みの都道府県。work_location は「東品川（最寄りは青物横丁または品川シーサイド）」
  // のように都道府県を含まない書き方が普通にあり、文字列一致だと勤務地20点が丸ごと0点になる
  workPrefecture?: string | null
  remotePolicy?: string | null
}

export interface RuleResult {
  total: number
  breakdown: string
}

function parseRateWan(rate: string | null | undefined): number | null {
  if (!rate) return null
  const m = rate.match(/(\d+(?:\.\d+)?)[\s\u3000]*万/)
  return m ? parseFloat(m[1]) : null
}

export function calcRuleScore(candidate: CandidateForScore, project: ProjectForScore): RuleResult {
  // ── スキル重複（必須 + 歓迎）最大 40pt ──
  const required = project.requiredSkills ?? []
  const cSet = new Set(candidate.skills.map(s => s.toLowerCase().trim()))
  let skillScore = 0
  let hits = 0
  if (required.length > 0) {
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      if (!rt) continue
      if (cSet.has(rt)) hits += 1
      else if ([...cSet].some(s => s.includes(rt) || rt.includes(s))) hits += 0.5
    }
    skillScore = Math.round((hits / required.length) * 40)
  } else {
    skillScore = 20
  }
  const niceToHave = project.niceToHaveSkills ?? []
  if (niceToHave.length > 0) {
    let niceHits = 0
    for (const n of niceToHave) {
      const nt = n.toLowerCase().trim()
      if (!nt) continue
      if (cSet.has(nt)) niceHits += 1
      else if ([...cSet].some(s => s.includes(nt) || nt.includes(s))) niceHits += 0.5
    }
    skillScore += Math.round(niceHits)
  }
  const cappedSkillScore = Math.min(40, skillScore)
  const skillDetail = required.length > 0
    ? `スキル${cappedSkillScore}/40(必須${required.length}中${Math.round(hits)}合致)`
    : `スキル${cappedSkillScore}/40(必須スキル未設定)`

  // ── 経験年数 ──
  const exp = candidate.experienceYears ?? 0
  let expScore = 0
  if (exp >= 10) expScore = 15
  else if (exp >= 7) expScore = 12
  else if (exp >= 5) expScore = 8
  else if (exp >= 3) expScore = 4
  else if (exp >= 1) expScore = 2
  const expDetail = `経験${expScore}/15(${exp}年)`

  // ── 単価合致 ──
  const rate = parseRateWan(candidate.desiredRate)
  let rateScore = 0
  let rateDetail: string
  if (project.budgetMax == null) {
    rateScore = 15
    rateDetail = `単価15/15(予算未設定)`
  } else if (rate !== null) {
    const bMin = project.budgetMin ?? 0
    const bMax = project.budgetMax
    if (rate >= bMin && rate <= bMax) {
      rateScore = 15
      rateDetail = `単価${rateScore}/15(${candidate.desiredRate})`
    } else if (rate <= bMax * 1.1) {
      rateScore = 8
      rateDetail = `単価${rateScore}/15(${candidate.desiredRate}・上限超過)`
    } else if (rate <= bMax * 1.2) {
      rateScore = 3
      rateDetail = `単価${rateScore}/15(${candidate.desiredRate}・上限超過)`
    } else {
      rateScore = 0
      rateDetail = `単価${rateScore}/15(${candidate.desiredRate}・上限超過)`
    }
  } else {
    rateScore = 0
    rateDetail = `単価0/15(単価不明)`
  }

  // ── 勤務地 ──
  const isFullRemote = /フルリモート|完全リモート|100[%％]リモート/.test(project.remotePolicy ?? '')
  // 正規化済みの work_prefecture を優先する（無いときだけ work_location の文字列で見る）
  const projLoc = (project.workPrefecture ?? project.workLocation ?? '').toLowerCase()
  let locationScore = 0
  let locationDetail: string
  if (isFullRemote) {
    locationScore = 20
    locationDetail = `勤務地20/20(フルリモート)`
  } else if (projLoc) {
    const candPref = (candidate.prefecture ?? '').toLowerCase()
    const prefOnly = (candPref.match(/^(.+?[都道府県])/) ?? [])[1] ?? candPref.split(/[\s\u3000]/)[0]
    const prefCore = prefOnly.replace(/[都道府県]$/, '')
    if (prefCore && projLoc.includes(prefCore)) {
      locationScore = 20
      locationDetail = `勤務地20/20(${candidate.prefecture ?? ''}・一致)`
    } else if (!candPref) {
      locationScore = 5
      locationDetail = `勤務地5/20(居住地不明)`
    } else {
      locationScore = 0
      locationDetail = `勤務地0/20(${candidate.prefecture ?? '不明'}・不一致)`
    }
  } else {
    locationScore = 5
    locationDetail = `勤務地5/20(居住地不明)`
  }

  // ── リモート対応 ──
  let remoteScore = 0
  let remoteDetail: string
  if (!isFullRemote && candidate.remoteAvailable && /リモート|remote|在宅/i.test(project.remotePolicy ?? '')) {
    remoteScore = 10
    remoteDetail = `リモート10/10(可・週リモート案件)`
  } else {
    remoteScore = 0
    remoteDetail = `リモート0/10`
  }

  const total = Math.min(100, cappedSkillScore + expScore + rateScore + locationScore + remoteScore)
  const breakdown = `${skillDetail} ${expDetail} ${rateDetail} ${locationDetail} ${remoteDetail} → 計${total}pt`
  return { total, breakdown }
}
