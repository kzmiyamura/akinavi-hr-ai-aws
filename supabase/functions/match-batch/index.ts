// Supabase Edge Function: match-batch
//
// ルールベース事前フィルタリング（案A）+ バッチAIプロンプト（案B）で
// 1案件あたりのAI呼び出しを 1回 に削減する。
//
// POST body:
//   mode: 'project_to_candidates' | 'candidate_to_projects'
//   --- project_to_candidates ---
//   projectRequirements: ProjectReq
//   candidates: CandidateInput[]
//   topN?: number  // AI に渡す上位件数（デフォルト10）
//   --- candidate_to_projects ---
//   candidateProfile: CandidateInput
//   projects: ProjectReq[]
//   topN?: number
//
// Response:
//   { results: BatchResult[], ruleOnly: BatchResult[], usedModel: string }
//   results  … AI スコアを持つ topN 件
//   ruleOnly … ルールスコアのみ（AIなし）の残り件数

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CEREBRAS_MODEL = 'llama3.1-8b'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GEMINI_MODEL = 'gemini-2.5-flash'

// ─── 型定義 ──────────────────────────────────────────────────────────────────

interface ScoringWeights {
  skill: number
  exp: number
  rate: number
  location: number
  remote: number
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  skill: 40,
  exp: 15,
  rate: 15,
  location: 20,
  remote: 10,
}

interface CandidateInput {
  id: string
  name: string
  skills: string[]
  experienceYears: number | null
  desiredRate: string | number | null
  summary: string
  remoteAvailable?: boolean | null
  wantsFullRemote?: boolean | null
  prefecture?: string | null
  availableRegions?: string[] | null
  preferredJobTypes?: string[] | null
  agentComment?: string | null
  nationality?: string | null
  selfPR?: string | null
  skillYears?: Record<string, number> | null  // スキル別経験月数（Excelから抽出）
  desiredProject?: string | null              // 希望案件・希望分野（raw_profile.desiredProject）
  hakenOk?: boolean | null                    // 派遣・常駐OK/NG（raw_profile.hakenOk）
  englishLevel?: 'business' | 'daily' | null // 英語レベル: business=業務レベル / daily=日常会話
}

interface ProjectReq {
  id?: string
  title: string
  requiredSkills: string[]
  niceToHaveSkills?: string[]
  budgetMin?: number | null
  budgetMax?: number | null
  workLocation?: string | null
  remotePolicy?: string | null
  contractType?: string | null               // 契約形態（'派遣'/'業務委託'/'準委任'/'請負'）
  description?: string | null
  roleSummary?: string | null
}

interface BatchResult {
  candidateId: string  // project_to_candidates
  projectId?: string   // candidate_to_projects（projectにidがある場合）
  score: number
  summary: string
  breakdown: string    // ルールスコアの内訳（AIなし時のフォールバック表示用）
  method: 'ai' | 'rule'
  ruleScore: number
}

// ─── 地方マップ ───────────────────────────────────────────────────────────────

const REGION_MAP: Record<string, string> = {
  '北海道': '北海道',
  '青森': '東北', '岩手': '東北', '宮城': '東北', '秋田': '東北', '山形': '東北', '福島': '東北',
  '茨城': '関東', '栃木': '関東', '群馬': '関東', '埼玉': '関東', '千葉': '関東', '東京': '関東', '神奈川': '関東',
  '新潟': '甲信越', '山梨': '甲信越', '長野': '甲信越',
  '富山': '北陸', '石川': '北陸', '福井': '北陸',
  '岐阜': '東海', '静岡': '東海', '愛知': '東海', '三重': '東海',
  '滋賀': '近畿', '京都': '近畿', '大阪': '近畿', '兵庫': '近畿', '奈良': '近畿', '和歌山': '近畿',
  '鳥取': '中国', '島根': '中国', '岡山': '中国', '広島': '中国', '山口': '中国',
  '徳島': '四国', '香川': '四国', '愛媛': '四国', '高知': '四国',
  '福岡': '九州', '佐賀': '九州', '長崎': '九州', '熊本': '九州', '大分': '九州', '宮崎': '九州', '鹿児島': '九州', '沖縄': '九州',
}

/** 都道府県名・勤務地文字列から都道府県コア（接尾辞なし）を抽出 */
function extractPrefCore(location: string): string {
  const lower = location.toLowerCase()
  const m = lower.match(/^(.+?)[都道府県]/)
  if (m) return m[1]
  return lower.split(/[\s\u3000]/)[0]
}

function getRegion(prefCore: string): string | null {
  return REGION_MAP[prefCore] ?? null
}

// ─── ルールベーススコアリング ─────────────────────────────────────────────────

/** 希望単価（文字列 or 数値）を月額万円に変換 */
function parseRateWan(rate: string | number | null | undefined): number | null {
  if (rate == null) return null
  if (typeof rate === 'number') return rate > 0 ? rate : null
  const m = rate.match(/(\d+(?:\.\d+)?)[\s　]*万/)
  return m ? parseFloat(m[1]) : null
}

interface RuleResult {
  total: number
  breakdown: string
}

/**
 * ルールベーススコアを計算（合計はウェイト合計に依存）
 * ウェイトが指定されない場合はデフォルト（スキル40/経験15/単価15/勤務地20/リモート10）を使用
 */
function calcRuleScore(candidate: CandidateInput, project: ProjectReq, weights: ScoringWeights = DEFAULT_WEIGHTS): RuleResult {
  const wSkill = weights.skill
  const wExp = weights.exp
  const wRate = weights.rate
  const wLoc = weights.location
  const wRemote = weights.remote

  // ── スキル重複（必須 + 歓迎）──
  const required = project.requiredSkills ?? []
  const cSet = new Set(candidate.skills.map(s => s.toLowerCase().trim()))
  let hits = 0
  if (required.length > 0) {
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      if (!rt) continue
      const isEnglish = rt === '英語' || rt === 'english' || rt.includes('英語')
      if (cSet.has(rt)) {
        if (isEnglish) {
          // 英語レベルで重みを変える: ビジネス=1.5倍 / 日常会話=0.8倍 / 不明=1.0
          if (candidate.englishLevel === 'business') hits += 1.5
          else if (candidate.englishLevel === 'daily') hits += 0.8
          else hits += 1
        } else {
          hits += 1
        }
      } else if (isEnglish && candidate.englishLevel != null) {
        // スキルに「英語」がなくてもメール本文で英語力が確認できれば加点
        // ビジネスレベル=1.0点 / 日常会話=0.5点
        if (candidate.englishLevel === 'business') hits += 1.0
        else hits += 0.5
      } else if ([...cSet].some(s => s.includes(rt) || rt.includes(s))) {
        hits += 0.5
      }
    }
  }
  // 歓迎スキル: 一致ごとに +1pt（部分一致 +0.5pt）
  const niceToHave = project.niceToHaveSkills ?? []
  let niceHits = 0
  if (niceToHave.length > 0) {
    for (const n of niceToHave) {
      const nt = n.toLowerCase().trim()
      if (!nt) continue
      if (cSet.has(nt)) niceHits += 1
      else if ([...cSet].some(s => s.includes(nt) || nt.includes(s))) niceHits += 0.5
    }
  }
  let skillRatio = required.length > 0 ? hits / required.length : 0.5
  skillRatio = Math.min(1.0, skillRatio + (niceToHave.length > 0 ? niceHits / niceToHave.length * 0.1 : 0))
  const cappedSkillScore = Math.min(wSkill, Math.round(skillRatio * wSkill))
  const skillDetail = required.length > 0
    ? `スキル${cappedSkillScore}/${wSkill}(必須${required.length}中${Math.round(hits)}合致)`
    : `スキル${cappedSkillScore}/${wSkill}(必須スキル未設定)`

  // ── 経験年数 ──
  // 優先順位:
  //   1. skillYears（Excel経歴書から取得した per-skill 月数） → 最も正確
  //   2. 必須スキルを「希望」と明示している人 → 5年相当(8/15)の部分クレジット
  //   3. 総経験年数（experienceYears） → スキル特化情報なし
  let exp = candidate.experienceYears
  // 総経験年数であることを明示（スキル特化情報なし）→ AI がスキル別年数と混同しないよう「総経験」を付与
  let expLabel = exp == null ? '不明' : `総経験${exp}年`
  let skillYearsUsed = false

  // 1. skillYears チェック
  if (candidate.skillYears && required.length > 0) {
    let maxSkillMonths = 0
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      for (const [skill, months] of Object.entries(candidate.skillYears)) {
        if (skill.toLowerCase().trim().includes(rt) || rt.includes(skill.toLowerCase().trim())) {
          if (months > maxSkillMonths) maxSkillMonths = months
        }
      }
    }
    if (maxSkillMonths > 0) {
      const skillExpYears = maxSkillMonths / 12
      if (exp == null || skillExpYears < exp) {
        exp = skillExpYears
        expLabel = `${skillExpYears.toFixed(1)}年(スキル別)`
        skillYearsUsed = true
      }
    }
  }

  // 2. 希望チェック（skillYears がない場合のみ）
  // desiredProject / selfPR / agentComment に必須スキルが含まれていれば
  // 「そのスキルを希望・得意としている」とみなして 5年相当(8/15) の部分クレジットを付与
  if (!skillYearsUsed && required.length > 0) {
    const wishText = [
      candidate.desiredProject ?? '',
      candidate.selfPR ?? '',
      candidate.agentComment ?? '',
    ].join(' ').toLowerCase()
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      if (rt.length >= 2 && cSet.has(rt) && wishText.includes(rt)) {
        // 希望あり → 5年相当(8/15)。確認済み7年(12/15)より低く、経験不明(5/15)より高い
        if (exp == null || exp < 5) {
          exp = 5
          expLabel = `${r}希望`
        }
        break
      }
    }
  }

  let expRatio = 0
  if (exp == null) expRatio = 5.0 / 15.0
  else if (exp >= 10) expRatio = 1.0
  else if (exp >= 7) expRatio = 12.0 / 15.0
  else if (exp >= 5) expRatio = 8.0 / 15.0
  else if (exp >= 3) expRatio = 4.0 / 15.0
  else if (exp >= 1) expRatio = 2.0 / 15.0
  const expScore = Math.round(expRatio * wExp)
  const expDetail = `経験${expScore}/${wExp}(${expLabel})`

  // ── 単価合致 ──
  const rate = parseRateWan(candidate.desiredRate)
  let rateRatio = 0
  let rateDetail: string
  if (project.budgetMax == null) {
    rateRatio = 1.0
    rateDetail = `単価${Math.round(rateRatio * wRate)}/${wRate}(予算未設定)`
  } else if (rate !== null) {
    const bMax = project.budgetMax
    if (rate <= bMax) {
      rateRatio = 1.0
      rateDetail = `単価${Math.round(rateRatio * wRate)}/${wRate}(${candidate.desiredRate})`
    } else if (rate <= bMax * 1.1) {
      rateRatio = 8.0 / 15.0
      rateDetail = `単価${Math.round(rateRatio * wRate)}/${wRate}(${candidate.desiredRate}・上限超過)`
    } else if (rate <= bMax * 1.2) {
      rateRatio = 3.0 / 15.0
      rateDetail = `単価${Math.round(rateRatio * wRate)}/${wRate}(${candidate.desiredRate}・上限超過)`
    } else {
      rateRatio = 0
      rateDetail = `単価0/${wRate}(${candidate.desiredRate}・上限超過)`
    }
  } else {
    rateRatio = 0
    rateDetail = `単価0/${wRate}(単価不明)`
  }
  const rateScore = Math.round(rateRatio * wRate)

  // ── 勤務地・居住地マッチング ──
  const isFullRemote = /フルリモート|完全リモート|100[%％]リモート/.test(project.remotePolicy ?? '')
  const projLoc = (project.workLocation ?? '').toLowerCase()
  let locRatio = 0
  let locationDetail: string
  if (isFullRemote) {
    locRatio = 1.0
    locationDetail = `勤務地${wLoc}/${wLoc}(フルリモート)`
  } else if (projLoc) {
    const candPref = (candidate.prefecture ?? '').toLowerCase()
    const prefOnly = (candPref.match(/^(.+?[都道府県])/) ?? [])[1] ?? candPref.split(/[\s　]/)[0]
    const prefCore = prefOnly.replace(/[都道府県]$/, '')
    const projPrefCoreForMatch = extractPrefCore(project.workLocation ?? '')
    if (prefCore && projPrefCoreForMatch && prefCore === projPrefCoreForMatch) {
      locRatio = 1.0
      locationDetail = `勤務地${wLoc}/${wLoc}(${candidate.prefecture ?? ''}・一致)`
    } else if (!candPref) {
      locRatio = 5.0 / 20.0
      locationDetail = `勤務地${Math.round(locRatio * wLoc)}/${wLoc}(居住地不明)`
    } else {
      // 同一地方チェック（例: 千葉→関東、東京→関東 → 同一地方で10pt）
      const candRegion = getRegion(prefCore)
      const projRegion = getRegion(projPrefCoreForMatch)
      if (candRegion && projRegion && candRegion === projRegion) {
        locRatio = 10.0 / 20.0
        locationDetail = `勤務地${Math.round(locRatio * wLoc)}/${wLoc}(${candidate.prefecture ?? ''}・同一地方${candRegion})`
      } else {
        locRatio = 0
        locationDetail = `勤務地0/${wLoc}(${candidate.prefecture ?? '不明'}・地方不一致)`
      }
    }
  } else {
    locRatio = 5.0 / 20.0
    locationDetail = `勤務地${Math.round(locRatio * wLoc)}/${wLoc}(居住地不明)`
  }
  const locationScore = Math.round(locRatio * wLoc)

  // ── リモート対応 ──
  // 案件側にリモート記載があるか（フルリモート含む）
  const projectHasRemote = isFullRemote || /リモート|remote|在宅/i.test(project.remotePolicy ?? '')
  let remoteScore = 0
  let remoteDetail: string
  const isHakenProjectForRemote = project.contractType === '派遣'
  if (candidate.wantsFullRemote && !projectHasRemote) {
    // フルリモート希望なのに常駐・リモートなし案件 → 減点
    remoteScore = -wRemote
    remoteDetail = `リモート-${wRemote}/${wRemote}(フルリモート希望・常駐案件)`
  } else if (isHakenProjectForRemote && candidate.hakenOk === true) {
    // 派遣（常駐）案件で常駐可 → リモート枠を常駐適応力として満点付与
    remoteScore = wRemote
    remoteDetail = `リモート${wRemote}/${wRemote}(常駐可・派遣案件)`
  } else if (!isFullRemote && candidate.remoteAvailable && /リモート|remote|在宅/i.test(project.remotePolicy ?? '')) {
    // リモート可 × 週リモート案件 → 加点
    remoteScore = wRemote
    remoteDetail = `リモート${wRemote}/${wRemote}(可・週リモート案件)`
  } else if (candidate.remoteAvailable == null) {
    // リモート可否不明 → 中間点
    remoteScore = Math.round(wRemote * 0.5)
    remoteDetail = `リモート${Math.round(wRemote * 0.5)}/${wRemote}(可否不明)`
  } else {
    remoteScore = 0
    remoteDetail = `リモート0/${wRemote}(${candidate.remoteAvailable ? '可・案件リモートなし' : '不可'})`
  }

  let total = Math.max(0, Math.min(wSkill + wExp + wRate + wLoc + wRemote, cappedSkillScore + expScore + rateScore + locationScore + remoteScore))
  // 必須スキルが1件以上あってかつ1件も合致しない場合は上限35ptに制限
  // （スキル全不一致なのに経験年数・単価・勤務地が良い人材が上位に来るのを防ぐ）
  if (required.length > 0 && hits === 0) {
    total = Math.min(total, 35)
  }
  // 派遣案件の加減点
  const isHakenProject = isHakenProjectForRemote
  let hakenNote = ''
  if (isHakenProject && candidate.hakenOk === false) {
    total = Math.min(total, 20)
    hakenNote = ' [派遣NG・派遣案件のため20pt上限]'
  } else if (isHakenProject && candidate.hakenOk === true) {
    total = Math.min(100, total + 5)
    hakenNote = ' [派遣OK+5pt]'
  }
  const fullRemoteNote = (candidate.wantsFullRemote && !projectHasRemote) ? ' [フルリモート希望・常駐案件]' : ''
  const breakdown = `${skillDetail} ${expDetail} ${rateDetail} ${locationDetail} ${remoteDetail} → 計${total}pt${fullRemoteNote}${hakenNote}`

  return { total, breakdown }
}

// ─── AI バッチ呼び出し ────────────────────────────────────────────────────────

/**
 * 候補者のスキルを案件関連スキルで絞り込む。
 * 必須・歓迎スキルに合致するものを優先し、最大 maxTotal 件に絞る。
 */
function filterRelevantSkills(
  candidateSkills: string[],
  requiredSkills: string[],
  niceToHaveSkills: string[],
  maxTotal = 10,
): string[] {
  const projectSkillSet = new Set(
    [...requiredSkills, ...niceToHaveSkills].map(s => s.toLowerCase().trim()),
  )
  const matching: string[] = []
  const others: string[] = []
  for (const skill of candidateSkills) {
    const st = skill.toLowerCase().trim()
    const isMatch = projectSkillSet.has(st) ||
      [...projectSkillSet].some(ps => st.includes(ps) || ps.includes(st))
    if (isMatch) matching.push(skill)
    else others.push(skill)
  }
  // 合致スキルを全件 + 残り枠を非合致で埋める
  const result = [...matching]
  for (const s of others) {
    if (result.length >= maxTotal) break
    result.push(s)
  }
  return result
}

function buildBatchProjectToCandidatesPrompt(
  project: ProjectReq,
  candidates: Array<CandidateInput & { ruleScore: number; ruleBreakdown?: string }>,
): string {
  const cList = candidates.map((c, i) => {
    const isNonJapanese = c.nationality && !['日本', '日本人'].includes(c.nationality)
    const skills = filterRelevantSkills(
      c.skills,
      project.requiredSkills ?? [],
      project.niceToHaveSkills ?? [],
    )
    // calcRuleScore の breakdown をそのまま渡してAIが事実記述できるようにする
    const rule = calcRuleScore(c, project)
    return (
      `[${i + 1}] id="${c.id}" score=${c.ruleScore} breakdown="${rule.breakdown}"` +
      ` matchedSkills=${JSON.stringify(skills)}` +
      (c.preferredJobTypes?.length ? ` wantedJobs=${JSON.stringify(c.preferredJobTypes)}` : '') +
      (c.summary ? ` summary="${c.summary.slice(0, 80)}"` : '') +
      (c.selfPR ? ` selfPR="${c.selfPR.slice(0, 80)}"` : '') +
      (c.agentComment ? ` agentNote="${c.agentComment.slice(0, 80)}"` : '') +
      (isNonJapanese ? ` nationality="${c.nationality}"` : '')
    )
  }).join('\n')

  return `人材と案件のマッチング評価。JSON配列のみ返す。説明文・コードブロック禁止。

案件:
- タイトル: ${project.title}
- 必須スキル: ${JSON.stringify(project.requiredSkills)}
- 予算: ${project.budgetMin ?? '?'}〜${project.budgetMax ?? '?'}万
- 勤務地: ${project.workLocation ?? '不明'} / リモート: ${project.remotePolicy ?? '不明'}
${project.roleSummary ? `- 役割: ${project.roleSummary.slice(0, 150)}` : ''}
${project.description ? `- 案件詳細: ${project.description.slice(0, 200)}` : ''}

候補者${candidates.length}名（score・breakdown はルールベース算出済み）:
${cList}

【指示】各候補者について以下を出力すること。
1. score（整数）: 各候補者の score をそのまま使うこと（変更禁止）
2. summary（80〜120字）: 以下のルールで日本語コメントを生成すること
   - breakdown の内容（スキル合致・経験・単価・勤務地）を自然な日本語で1〜2文にまとめる
   - スコア数値・分数は出力しない
   - matchedSkills があれば具体的なスキル名を含める（ない場合は「スキル不一致」）
   - breakdown に「勤務地XX/20」と記載があればその事実のみ書く（「リモート不可」等の推測追記禁止）
   - summary/selfPR/agentNote がある場合は案件との適合を1文追加
   - wantedJobs がある場合は案件との合致を1文追加
   - nationality がある場合はビザ・日本語要件の確認を1文追加

出力形式（配列のみ・改行なし）: [{"id":"...","score":整数,"summary":"120字以内"},...]`
}

function buildBatchCandidateToProjectsPrompt(
  candidate: CandidateInput,
  projects: Array<ProjectReq & { ruleScore: number }>,
): string {
  const pList = projects.map((p, i) =>
    `[${i + 1}] id="${p.id ?? i}" title="${p.title}" required=${JSON.stringify(p.requiredSkills)} budget=${p.budgetMin ?? '?'}〜${p.budgetMax ?? '?'}万`
  ).join('\n')

  return `人材と案件のマッチングコメント生成。JSON配列のみ返す。説明文・コードブロック禁止。

人材: name="${candidate.name}" skills=${JSON.stringify(candidate.skills)} exp=${candidate.experienceYears}年 rate="${candidate.desiredRate ?? ''}" pref="${candidate.prefecture ?? ''}"` +
    (candidate.availableRegions?.length ? ` regions=${JSON.stringify(candidate.availableRegions)}` : '') +
    (candidate.preferredJobTypes?.length ? ` wantedJobs=${JSON.stringify(candidate.preferredJobTypes)}` : '') +
    ` summary="${candidate.summary.slice(0, 100)}"` +
    (candidate.agentComment ? ` comment="${candidate.agentComment.slice(0, 100)}"` : '') + `

案件${projects.length}件:
${pList}

各案件についてマッチングコメントを50字以内で生成（スコアは不要）。
出力形式（配列のみ・改行なし）: [{"id":"...","summary":"50字以内"},...]`
}

async function callGroq(key: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  return data.choices[0].message.content as string
}

async function callCerebras(prompt: string): Promise<string> {
  const key = Deno.env.get('CEREBRAS_API_KEY')
  if (!key) throw new Error('CEREBRAS_API_KEY not set')
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CEREBRAS_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Cerebras ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  return data.choices[0].message.content as string
}

async function callGemini(prompt: string): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) throw new Error('GEMINI_API_KEY not set')
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8000 },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const data = await res.json()
  return data.candidates[0].content.parts[0].text as string
}

/** AI を呼び出して JSON テキストを返す（Cerebras → Groq → Gemini フォールバック） */
async function callAI(prompt: string): Promise<{ text: string; model: string }> {
  const groqKey = Deno.env.get('GROQ_API_KEY')
  const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY')

  // Cerebras の上限は 8192 トークン（1トークン≒3文字で概算）
  // 7500 トークン相当（22500 文字）を超える場合はスキップして Groq へ
  const CEREBRAS_CHAR_LIMIT = 22500
  if (cerebrasKey && prompt.length <= CEREBRAS_CHAR_LIMIT) {
    try {
      const text = await callCerebras(prompt)
      return { text, model: CEREBRAS_MODEL }
    } catch (e) {
      console.warn(`[match-batch] Cerebras失敗: ${e}`)
    }
  } else if (cerebrasKey && prompt.length > CEREBRAS_CHAR_LIMIT) {
    console.log(`[match-batch] Cerebrasスキップ: プロンプト${prompt.length}文字 > 上限${CEREBRAS_CHAR_LIMIT}文字`)
  }
  if (groqKey) {
    try {
      const text = await callGroq(groqKey, prompt)
      return { text, model: GROQ_MODEL }
    } catch (e) {
      console.warn(`[match-batch] Groq失敗: ${e}`)
    }
  }
  const text = await callGemini(prompt)
  return { text, model: GEMINI_MODEL }
}

/** AI 応答テキストから JSON 配列を抽出 */
function parseArrayResponse(text: string): Array<{ id: string; score: number | null; summary: string }> {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const m = cleaned.match(/\[[\s\S]*\]/)
  if (!m) throw new Error(`JSON配列が見つかりません: ${cleaned.slice(0, 200)}`)
  const arr = JSON.parse(m[0])
  if (!Array.isArray(arr)) throw new Error('配列ではありません')
  return arr.map(item => {
    const rawScore = item.score
    const score = typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 100
      ? Math.round(rawScore)
      : null
    return {
      id: String(item.id ?? ''),
      score,
      summary: typeof item.summary === 'string' ? item.summary : '',
    }
  })
}

// ─── メインハンドラー ──────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json()
    const { mode = 'project_to_candidates', topN = 10, weights: rawWeights } = body as {
      mode?: string
      topN?: number
      weights?: Partial<ScoringWeights>
    }
    const weights: ScoringWeights = {
      skill:    rawWeights?.skill    ?? DEFAULT_WEIGHTS.skill,
      exp:      rawWeights?.exp      ?? DEFAULT_WEIGHTS.exp,
      rate:     rawWeights?.rate     ?? DEFAULT_WEIGHTS.rate,
      location: rawWeights?.location ?? DEFAULT_WEIGHTS.location,
      remote:   rawWeights?.remote   ?? DEFAULT_WEIGHTS.remote,
    }

    // ── project → candidates ──────────────────────────────────────────────────
    if (mode === 'project_to_candidates') {
      const { projectRequirements, candidates } = body as {
        projectRequirements: ProjectReq
        candidates: CandidateInput[]
      }
      if (!projectRequirements || !Array.isArray(candidates) || candidates.length === 0) {
        return new Response(JSON.stringify({ error: 'projectRequirements と candidates が必要です' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // ルールスコアで全員採点 → ソート
      const scored = candidates.map(c => { const r = calcRuleScore(c, projectRequirements, weights); return { ...c, ruleScore: r.total, ruleBreakdown: r.breakdown } })
      scored.sort((a, b) => b.ruleScore - a.ruleScore)

      const aiTargets = scored.slice(0, topN)
      const ruleRest = scored.slice(topN)

      let usedModel = 'rule'
      let aiResults: Array<{ id: string; score: number | null; summary: string }> = []

      if (aiTargets.length > 0) {
        const prompt = buildBatchProjectToCandidatesPrompt(projectRequirements, aiTargets)
        try {
          const { text, model } = await callAI(prompt)
          usedModel = model
          aiResults = parseArrayResponse(text)
        } catch (e) {
          console.warn(`[match-batch] AI失敗、ルールスコアで代替: ${e}`)
          aiResults = []
          usedModel = 'rule'
        }
      }

      // AI結果をidでマップ
      const aiMap = new Map(aiResults.map(r => [r.id, r]))

      // topN: AIスコアを優先採用（取得できなければruleScoreで代替）
      const results: BatchResult[] = aiTargets.map(c => {
        const ai = aiMap.get(c.id)
        return {
          candidateId: c.id,
          score: ai?.score ?? c.ruleScore,
          summary: ai?.summary ?? '',
          breakdown: c.ruleBreakdown,
          method: ai ? 'ai' : 'rule',
          ruleScore: c.ruleScore,
        }
      })

      // 残り: ruleScoreのみ
      const ruleOnly: BatchResult[] = ruleRest.map(c => ({
        candidateId: c.id,
        score: c.ruleScore,
        summary: '',
        breakdown: c.ruleBreakdown,
        method: 'rule' as const,
        ruleScore: c.ruleScore,
      }))

      return new Response(
        JSON.stringify({ results, ruleOnly, usedModel }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // ── candidate → projects ──────────────────────────────────────────────────
    if (mode === 'candidate_to_projects') {

      const { candidateProfile, projects } = body as {
        candidateProfile: CandidateInput
        projects: ProjectReq[]
      }
      if (!candidateProfile || !Array.isArray(projects) || projects.length === 0) {
        return new Response(JSON.stringify({ error: 'candidateProfile と projects が必要です' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const scored = projects.map(p => { const r = calcRuleScore(candidateProfile, p, weights); return { ...p, ruleScore: r.total, ruleBreakdown: r.breakdown } })
      scored.sort((a, b) => b.ruleScore - a.ruleScore)

      const aiTargets = scored.slice(0, topN)
      const ruleRest = scored.slice(topN)

      let usedModel = 'rule'
      let aiResults: Array<{ id: string; score: number | null; summary: string }> = []

      if (aiTargets.length > 0) {
        const prompt = buildBatchCandidateToProjectsPrompt(candidateProfile, aiTargets)
        try {
          const { text, model } = await callAI(prompt)
          usedModel = model
          aiResults = parseArrayResponse(text)
        } catch (e) {
          console.warn(`[match-batch] AI失敗、ルールスコアで代替: ${e}`)
          aiResults = []
          usedModel = 'rule'
        }
      }

      const aiMap = new Map(aiResults.map(r => [r.id, r]))

      // topN: AIスコアを優先採用（取得できなければruleScoreで代替）
      const results: BatchResult[] = aiTargets.map(p => {
        const ai = aiMap.get(String(p.id ?? ''))
        return {
          candidateId: '',
          projectId: String(p.id ?? ''),
          score: ai?.score ?? p.ruleScore,
          summary: ai?.summary ?? '',
          breakdown: p.ruleBreakdown,
          method: ai ? 'ai' : 'rule',
          ruleScore: p.ruleScore,
        }
      })

      // 残り: ruleScoreのみ
      const ruleOnly: BatchResult[] = ruleRest.map(p => ({
        candidateId: '',
        projectId: String(p.id ?? ''),
        score: p.ruleScore,
        summary: '',
        breakdown: p.ruleBreakdown,
        method: 'rule' as const,
        ruleScore: p.ruleScore,
      }))

      return new Response(
        JSON.stringify({ results, ruleOnly, usedModel }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ error: `未知のmode: ${mode}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('[match-batch] エラー:', String(e))
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
