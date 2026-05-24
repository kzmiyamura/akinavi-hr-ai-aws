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

interface CandidateInput {
  id: string
  name: string
  skills: string[]
  experienceYears: number | null
  desiredRate: string | null
  summary: string
  remoteAvailable?: boolean | null
  prefecture?: string | null
  availableRegions?: string[] | null
  preferredJobTypes?: string[] | null
  agentComment?: string | null
  nationality?: string | null
  selfPR?: string | null
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
  description?: string | null
  roleSummary?: string | null
}

interface BatchResult {
  candidateId: string  // project_to_candidates
  projectId?: string   // candidate_to_projects（projectにidがある場合）
  score: number
  summary: string
  method: 'ai' | 'rule'
  ruleScore: number
}

// ─── ルールベーススコアリング ─────────────────────────────────────────────────

/** 希望単価文字列を月額万円に変換 */
function parseRateWan(rate: string | null | undefined): number | null {
  if (!rate) return null
  const m = rate.match(/(\d+(?:\.\d+)?)[\s　]*万/)
  return m ? parseFloat(m[1]) : null
}

interface RuleResult {
  total: number
  breakdown: string
}

/**
 * ルールベーススコアを計算（0〜100）
 * - スキル重複率  : 0〜40 pt
 * - 経験年数      : 0〜15 pt
 * - 単価合致      : 0〜15 pt
 * - 勤務地一致    : 0〜20 pt
 * - リモート      : 0〜10 pt
 */
function calcRuleScore(candidate: CandidateInput, project: ProjectReq): RuleResult {
  // ── スキル重複（必須 + 歓迎）最大 40pt ──
  const required = project.requiredSkills ?? []
  const cSet = new Set(candidate.skills.map(s => s.toLowerCase().trim()))
  let skillScore = 0
  let hits = 0
  if (required.length > 0) {
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      if (!rt) continue
      if (cSet.has(rt)) {
        hits += 1
      } else if ([...cSet].some(s => s.includes(rt) || rt.includes(s))) {
        hits += 0.5
      }
    }
    skillScore = Math.round((hits / required.length) * 40)
  } else {
    skillScore = 20
  }
  // 歓迎スキル: 一致ごとに +1pt（部分一致 +0.5pt）、上乗せして 40pt キャップ
  const niceToHave = project.niceToHaveSkills ?? []
  if (niceToHave.length > 0) {
    let niceHits = 0
    for (const n of niceToHave) {
      const nt = n.toLowerCase().trim()
      if (!nt) continue
      if (cSet.has(nt)) {
        niceHits += 1
      } else if ([...cSet].some(s => s.includes(nt) || nt.includes(s))) {
        niceHits += 0.5
      }
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

  // ── 勤務地・居住地マッチング ──
  const isFullRemote = /フルリモート|完全リモート|100[%％]リモート/.test(project.remotePolicy ?? '')
  const projLoc = (project.workLocation ?? '').toLowerCase()
  let locationScore = 0
  let locationDetail: string
  if (isFullRemote) {
    locationScore = 20
    locationDetail = `勤務地20/20(フルリモート)`
  } else if (projLoc) {
    const candPref = (candidate.prefecture ?? '').toLowerCase()
    const prefCore = candPref.replace(/[都道府県]$/, '')
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
  } else if (candidate.remoteAvailable) {
    remoteScore = 0
    remoteDetail = `リモート0/10(可だがフルリモート案件のため対象外)`
  } else {
    remoteScore = 0
    remoteDetail = `リモート0/10(不可)`
  }

  const total = Math.min(100, cappedSkillScore + expScore + rateScore + locationScore + remoteScore)
  const breakdown = `${skillDetail} ${expDetail} ${rateDetail} ${locationDetail} ${remoteDetail} → 計${total}pt`

  return { total, breakdown }
}

// ─── AI バッチ呼び出し ────────────────────────────────────────────────────────

function buildBatchProjectToCandidatesPrompt(
  project: ProjectReq,
  candidates: Array<CandidateInput & { ruleScore: number; ruleBreakdown?: string }>,
): string {
  const projectRoleText = `${project.title} ${project.roleSummary ?? ''} ${project.description ?? ''}`.toLowerCase()
  const NEGATION_KEYWORDS = ['希望しない', '希望せず', 'したくない', '不可', '避けたい']

  const cList = candidates.map((c, i) => {
    const isNonJapanese = c.nationality && !['日本', '日本人'].includes(c.nationality)
    // wantedJobsが全て案件テキストに含まれない場合はミスマッチ
    const mismatchedJobs = (c.preferredJobTypes ?? []).filter(j => !projectRoleText.includes(j.toLowerCase()))
    const hasJobMismatch = mismatchedJobs.length > 0 && mismatchedJobs.length === (c.preferredJobTypes?.length ?? 0)
    const selfPRHasNegation = c.selfPR && NEGATION_KEYWORDS.some(k => c.selfPR!.includes(k))
    // 警告文を事前生成（AIはそのままコピーするだけでよい）
    const warnings: string[] = []
    if (hasJobMismatch) warnings.push(`希望職種(${mismatchedJobs.join('・')})と案件の役割が不一致のため要確認。`)
    if (selfPRHasNegation) warnings.push(`selfPRに「${c.selfPR!.slice(0, 30)}」とあり案件との矛盾を要確認。`)
    if (isNonJapanese) warnings.push(`${c.nationality}のため就労ビザ・日本語要件の確認が必要。`)
    return (
      `[${i + 1}] id="${c.id}" name="${c.name}" ruleScore=${c.ruleScore} ruleBreakdown="${(c as { ruleBreakdown?: string }).ruleBreakdown ?? ''}"` +
      ` skills=${JSON.stringify(c.skills)} exp=${c.experienceYears}年 rate="${c.desiredRate ?? ''}" pref="${c.prefecture ?? ''}" remote=${c.remoteAvailable ? '可' : '不可'}` +
      (c.availableRegions?.length ? ` regions=${JSON.stringify(c.availableRegions)}` : '') +
      (c.preferredJobTypes?.length ? ` wantedJobs=${JSON.stringify(c.preferredJobTypes)}` : '') +
      ` summary="${c.summary.slice(0, 200)}"` +
      (c.selfPR ? ` selfPR="${c.selfPR.slice(0, 200)}"` : '') +
      (c.agentComment ? ` agentNote="${c.agentComment.slice(0, 150)}"` : '') +
      (warnings.length > 0 ? ` [警告・必ずsummaryに含めること: ${warnings.join(' ')}]` : '')
    )
  }).join('\n')

  return `人材と案件のマッチング評価。JSON配列のみ返す。説明文・コードブロック禁止。

案件:
- タイトル: ${project.title}
- 必須スキル: ${JSON.stringify(project.requiredSkills)}
- 予算: ${project.budgetMin ?? '?'}〜${project.budgetMax ?? '?'}万
- 勤務地: ${project.workLocation ?? '不明'} / リモート: ${project.remotePolicy ?? '不明'}
${project.roleSummary ? `- 役割: ${project.roleSummary.slice(0, 200)}` : ''}
${project.description ? `- 案件詳細: ${project.description.slice(0, 300)}` : ''}

候補者${candidates.length}名（ruleScore はスキル/経験/単価/場所のルールベース点、ruleBreakdown は各項目の内訳）:
${cList}

【指示】各候補者について以下を出力すること。
1. score（整数）: ruleBreakdown の末尾「→ 計Xpt」の数値をそのまま使うこと（変更禁止）
2. summary（100〜150字）: 以下の順で必ず含めること
   a) ruleBreakdown の各項目を自然な日本語に変換（スキル合致・経験・単価・勤務地・リモート）
      例: "スキル3/5合致(Java・Spring Boot・テストが一致)。経験6年で要件を満たす。単価75万は予算内。北海道在住のためリモート不可では出社困難。"
   b) 案件の役割・人物像（roleSummary/description）と候補者の特徴（summary・selfPR・agentNote）の適合度を1文で述べること
      - selfPR や summary に「希望しない」「不可」「避けたい」等の否定表現がある場合、案件との矛盾を必ず指摘すること
      例: "案件が求めるリーダー経験に対し、本人も PM 希望で意欲的。" / "selfPR にバックエンド業務を希望しないとあり、案件の役割と明確にミスマッチ。"
   c) 候補者データに [警告・必ずsummaryに含めること: ...] がある場合、その警告文をsummaryの末尾にそのままコピーすること（改変禁止）

出力形式（配列のみ・改行なし）: [{"id":"...","score":整数,"summary":"150字以内"},...]`
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
      max_tokens: 2000,
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
      max_tokens: 2000,
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
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
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

  if (cerebrasKey) {
    try {
      const text = await callCerebras(prompt)
      return { text, model: CEREBRAS_MODEL }
    } catch (e) {
      console.warn(`[match-batch] Cerebras失敗: ${e}`)
    }
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
    const { mode = 'project_to_candidates', topN = 10 } = body as {
      mode?: string
      topN?: number
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
      const scored = candidates.map(c => { const r = calcRuleScore(c, projectRequirements); return { ...c, ruleScore: r.total, ruleBreakdown: r.breakdown } })
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
          method: ai ? 'ai' : 'rule',
          ruleScore: c.ruleScore,
        }
      })

      // 残り: ruleScoreのみ
      const ruleOnly: BatchResult[] = ruleRest.map(c => ({
        candidateId: c.id,
        score: c.ruleScore,
        summary: '',
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

      const scored = projects.map(p => { const r = calcRuleScore(candidateProfile, p); return { ...p, ruleScore: r.total, ruleBreakdown: r.breakdown } })
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
