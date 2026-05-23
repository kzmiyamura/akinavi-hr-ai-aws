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

/**
 * ルールベーススコアを計算（0〜100）
 * - スキル重複率  : 0〜40 pt
 * - 経験年数      : 0〜15 pt
 * - 単価合致      : 0〜15 pt
 * - 勤務地一致    : 0〜20 pt
 * - リモート      : 0〜10 pt
 */
function calcRuleScore(candidate: CandidateInput, project: ProjectReq): number {
  let score = 0

  // ── スキル重複 ──
  const required = project.requiredSkills ?? []
  if (required.length > 0) {
    const cSet = new Set(candidate.skills.map(s => s.toLowerCase().trim()))
    let hits = 0
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      if (!rt) continue
      if (cSet.has(rt)) {
        hits += 1
      } else if ([...cSet].some(s => s.includes(rt) || rt.includes(s))) {
        hits += 0.5
      }
    }
    score += Math.min(40, Math.round((hits / required.length) * 40))
  } else {
    score += 20
  }

  // ── 経験年数 ──
  const exp = candidate.experienceYears ?? 0
  if (exp >= 10) score += 15
  else if (exp >= 7) score += 12
  else if (exp >= 5) score += 8
  else if (exp >= 3) score += 4
  else if (exp >= 1) score += 2

  // ── 単価合致 ──
  const rate = parseRateWan(candidate.desiredRate)
  if (project.budgetMax == null) {
    // 予算上限未設定 → 制約なしとみなして全加点
    score += 15
  } else if (rate !== null) {
    const bMin = project.budgetMin ?? 0
    const bMax = project.budgetMax
    if (rate >= bMin && rate <= bMax) score += 15
    else if (rate <= bMax * 1.1) score += 8
    else if (rate <= bMax * 1.2) score += 3
  }

  // ── 勤務地・居住地マッチング ──
  const isFullRemote = /フルリモート|完全リモート|100[%％]リモート/.test(project.remotePolicy ?? '')
  const projLoc = (project.workLocation ?? '').toLowerCase()
  if (isFullRemote) {
    // フルリモートならどこに住んでいても問題なし
    score += 20
  } else if (projLoc) {
    const candPref = (candidate.prefecture ?? '').toLowerCase()
    // 都道府県の末尾（都/道/府/県）を除いたコア部分で照合
    // 例: "東京都" → "東京" が "東京都港区田町" に含まれるか
    const prefCore = candPref.replace(/[都道府県]$/, '')
    if (prefCore && projLoc.includes(prefCore)) score += 20
    // 居住地不明の場合はペナルティなし
    else if (!candPref) score += 5
  }

  // ── リモート対応 ──
  if (!isFullRemote && candidate.remoteAvailable && /リモート|remote|在宅/i.test(project.remotePolicy ?? '')) {
    score += 10
  }

  return Math.min(100, score)
}

// ─── AI バッチ呼び出し ────────────────────────────────────────────────────────

function buildBatchProjectToCandidatesPrompt(
  project: ProjectReq,
  candidates: Array<CandidateInput & { ruleScore: number }>,
): string {
  const cList = candidates.map((c, i) =>
    `[${i + 1}] id="${c.id}" name="${c.name}" ruleScore=${c.ruleScore}` +
    ` skills=${JSON.stringify(c.skills)} exp=${c.experienceYears}年 rate="${c.desiredRate ?? ''}" pref="${c.prefecture ?? ''}"` +
    (c.availableRegions?.length ? ` regions=${JSON.stringify(c.availableRegions)}` : '') +
    (c.preferredJobTypes?.length ? ` wantedJobs=${JSON.stringify(c.preferredJobTypes)}` : '') +
    ` summary="${c.summary.slice(0, 200)}"` +
    (c.agentComment ? ` agentNote="${c.agentComment.slice(0, 150)}"` : '')
  ).join('\n')

  return `人材と案件のマッチング評価。JSON配列のみ返す。説明文・コードブロック禁止。

案件:
- タイトル: ${project.title}
- 必須スキル: ${JSON.stringify(project.requiredSkills)}
- 予算: ${project.budgetMin ?? '?'}〜${project.budgetMax ?? '?'}万
- 勤務地: ${project.workLocation ?? '不明'} / リモート: ${project.remotePolicy ?? '不明'}
${project.roleSummary ? `- 役割: ${project.roleSummary.slice(0, 200)}` : ''}
${project.description ? `- 案件詳細: ${project.description.slice(0, 300)}` : ''}

候補者${candidates.length}名（ruleScore はスキル/経験/単価/場所のルールベース点）:
${cList}

【指示】各候補者について以下を出力すること。
1. score（0〜100の整数）: ruleScore を参考にしつつ、案件の役割・詳細・候補者の希望職種・経歴サマリーを加味して再採点する
   - ruleScore が高くても案件の役割と経歴が合わなければ下げる
   - ruleScore が低くても候補者の希望・経歴が案件に合っていれば上げる
   - agentNote（人物評）がある場合、案件の求める人物像との相性をスコアに反映する
2. summary（150字以内）: スコアの根拠を具体的に記述する。以下の観点を優先順に含めること
   - 必須スキルの合致状況（何が合っていて何が不足か）
   - 経験年数と案件要件の比較
   - 単価の合致・乖離
   - 勤務地・リモート希望の一致
   - agentNote がある場合は人物評の特筆すべき点を1文で添える
   - 懸念点や不足スキルがあれば明記

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
      const scored = candidates.map(c => ({ ...c, ruleScore: calcRuleScore(c, projectRequirements) }))
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

      const scored = projects.map(p => ({ ...p, ruleScore: calcRuleScore(candidateProfile, p) }))
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
