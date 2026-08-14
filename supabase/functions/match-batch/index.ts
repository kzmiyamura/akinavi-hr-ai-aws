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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * 必須スキルの充足判定を DB（skill_satisfies）に問い合わせる。
 *
 * 判定は 2026-08-12 に skill_satisfies へ集約したが、ここだけ自前の双方向部分一致
 * （`have.includes(want) || want.includes(have)` で +0.5）が残っていて、画面の
 * 「スコア内訳」だけ旧ルールで動いていた。実害（2026-08-13）:
 *   必須 = 基本設計/Microsoft 365/PowerShell/EntraID/Azure Functions に対し
 *   候補者スキル「C」「Shell」が Microsoft 365・Azure Functions・PowerShell に
 *   部分一致して「必須5中3合致」。目視では基本設計しか合っていない。
 *
 * バッチ全体を1往復で解決する（1人ずつ match_skill_strings を呼ぶと20往復になる）。
 * 失敗時は完全一致のみに退化させる。旧ルールには戻さない（戻すと誤合致が復活する）。
 */
async function fetchSatisfiedRequired(
  haves: string[][],
  want: string[],
): Promise<Map<number, Set<string>> | null> {
  if (want.length === 0 || haves.length === 0) return new Map()
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !key) {
    console.warn('[skill-match] SUPABASE_URL/KEY が無いため完全一致のみで採点する')
    return null
  }
  try {
    const supabase = createClient(url, key)
    const { data, error } = await supabase.rpc('match_skill_hits_batch', {
      p_haves: haves,
      p_want: want,
    })
    if (error) throw new Error(error.message)
    const map = new Map<number, Set<string>>()
    for (const row of (data ?? []) as { idx: number; want: string }[]) {
      if (!map.has(row.idx)) map.set(row.idx, new Set())
      map.get(row.idx)!.add(row.want)
    }
    return map
  } catch (e) {
    console.warn('[skill-match] match_skill_hits_batch 失敗、完全一致のみで採点する:', String(e))
    return null
  }
}

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
  roles?: string[] | null                     // 役割（raw_profile.roles）。先頭が主役割
  hakenOk?: boolean | null                    // 派遣・常駐OK/NG（raw_profile.hakenOk）
  englishLevel?: 'business' | 'daily' | null // 英語レベル: business=業務レベル / daily=日常会話
  employmentType?: string | null             // 雇用形態: 派遣社員/正社員/フリーランス/業務委託/SES等
  hakenLicenseVerified?: boolean | null      // エージェントの派遣免許確認済み（agent_companiesより）
}

interface ProjectReq {
  id?: string
  title: string
  requiredSkills: string[]
  niceToHaveSkills?: string[]
  budgetMin?: number | null
  budgetMax?: number | null
  // 必須スキルごとの重み（skill_master のカテゴリで傾斜。languages=4 … methodologies=1）。
  // 順位付けをする fetch_candidates_for_project は重み付きで採点しているのに、
  // 画面に出るこちらは単純比率のままだった（2026-08-13）。同じ配点にする
  skillWeights?: Record<string, number> | null
  // 案件が明示している必要経験年数。順位付け側はこれを基準に採点するのに
  // こちらは常に 10/7/5/3/1年の固定階段で、案件要件を無視していた
  requiredExpYears?: number | null
  workLocation?: string | null
  // 正規化済みの都道府県。work_location は「東品川（最寄りは青物横丁または品川シーサイド）」
  // のように都道府県を含まない書き方が普通にあり、文字列から切り出すと勤務地20点が丸ごと
  // 0点になる。fetch_candidates_for_project と同じくこちらを正とする
  workPrefecture?: string | null
  remotePolicy?: string | null
  requiredRole?: string | null               // 求める役割（raw_data.aiInterpretation.requiredRole）
  contractType?: string | null               // 契約形態（'派遣'/'業務委託'/'準委任'/'請負'）
  description?: string | null
  roleSummary?: string | null
  requiresEnglish?: 'none' | 'business' | 'native' // 英語要件
  allowedEmploymentTypes?: string[] | null         // 受け入れ雇用形態（null = 制限なし）
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

// ─── 役割の合致度 ─────────────────────────────────────────────────────────────
// ⚠ DB の role_master / role_affinity と**同じ内容**にすること
//   （supabase/migrations/20260814_role_master.sql）。
//   ズレると SQL が決める順位と、ここが決める表示スコアが食い違う。
// PMO は management と support の両方に属する（2026-08-14 ユーザー指摘:
//   「運用サポートはまさに PMO も含む」）。
const ROLE_FAMILIES: Record<string, string[]> = {
  'プロジェクトマネージャー': ['management'],
  'PMO': ['management', 'support'],
  'プロジェクトリーダー': ['management'],
  'スクラムマスター': ['management'],
  'コンサルタント': ['management'],
  'システムエンジニア': ['engineering'],
  'プログラマー': ['engineering'],
  'テックリード': ['engineering', 'management'],
  'アーキテクト': ['engineering', 'management'],
  'インフラエンジニア': ['engineering'],
  'フロントエンドエンジニア': ['engineering'],
  'バックエンドエンジニア': ['engineering'],
  'フルスタックエンジニア': ['engineering'],
  'クラウドエンジニア': ['engineering'],
  'データエンジニア': ['engineering'],
  'MLエンジニア': ['engineering'],
  'ヘルプデスク': ['support'],
  '運用保守': ['support'],
  'テストエンジニア': ['support'],
}
/** SQL の p_weight_role の既定値と揃える */
const ROLE_WEIGHT = 30

/** 同一 1.0 / 同系統 0.7 / 系統違い 0.2 / どちらか不明 0.5（ゲートではない） */
function roleAffinity(required: string | null, candidate: string | null): number {
  if (!required?.trim() || !candidate?.trim()) return 0.5
  if (required === candidate) return 1.0
  const a = ROLE_FAMILIES[required] ?? []
  const b = ROLE_FAMILIES[candidate] ?? []
  return a.some((f) => b.includes(f)) ? 0.7 : 0.2
}

// ─── ルールベーススコアリング ─────────────────────────────────────────────────

/** 希望単価（文字列 or 数値）を月額万円に変換 */
/**
 * 希望単価の文字列から「万」単位の金額を読む。
 *
 * 複数の金額が書かれている場合は**最大値**を採る。
 * 先頭だけを見ると「55万円以上希望（PMOなどは67万円）」が 55 と解釈され、
 * 予算65万の案件で満点になっていた（2026-08-13 実害）。実際に求めているのは
 * 条件次第で67万なので、予算超過の判定には高い方を使う。
 * 「80万（140～180h）」のような稼働時間は「万」が付かないので混ざらない。
 */
function parseRateWan(rate: string | number | null | undefined): number | null {
  if (rate == null) return null
  if (typeof rate === 'number') return rate > 0 ? rate : null
  const found: number[] = []
  for (const m of rate.matchAll(/(\d+(?:\.\d+)?)[\s　]*万/g)) {
    const n = parseFloat(m[1])
    // 単価として現実的な範囲だけ採る（人月単価。桁違いの誤読を弾く）
    if (Number.isFinite(n) && n > 0 && n <= 500) found.push(n)
  }
  return found.length > 0 ? Math.max(...found) : null
}

interface RuleResult {
  total: number
  breakdown: string
}

/**
 * ルールベーススコアを計算（合計はウェイト合計に依存）
 * ウェイトが指定されない場合はデフォルト（スキル40/経験15/単価15/勤務地20/リモート10）を使用
 */
function calcRuleScore(
  candidate: CandidateInput,
  project: ProjectReq,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  // DB（skill_satisfies）が「充足した」と判定した必須スキル。
  // null のときは RPC が使えなかった場合で、完全一致のみに退化する
  satisfiedRequired?: Set<string> | null,
): RuleResult {
  const wSkill = weights.skill
  const wExp = weights.exp
  const wRate = weights.rate
  const wLoc = weights.location
  const wRemote = weights.remote

  // ── スキル重複（必須 + 歓迎）──
  const required = project.requiredSkills ?? []
  const cSet = new Set(candidate.skills.map(s => s.toLowerCase().trim()))
  // 必須スキルごとの重み。fetch_candidates_for_project と同じく
  // skill_weights のキーは元の表記なので小文字で突き合わせ、未指定は 1 とする
  const weightLookup = new Map<string, number>()
  for (const [k, v] of Object.entries(project.skillWeights ?? {})) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) weightLookup.set(k.toLowerCase().trim(), n)
  }
  const weightOf = (skill: string) => weightLookup.get(skill.toLowerCase().trim()) ?? 1
  // 合致数（表示用）と重み付き合致（スコア用）を別に数える。
  // 「必須5中1合致」は人が数を確認するための表示なので重みを掛けない
  let hits = 0
  let hitWeight = 0
  // どの必須スキルで合致したか。数字だけ出しても人が確認できないので内訳に名前を出す
  const hitNames: string[] = []
  const totalWeight = required.reduce((a, r) => a + weightOf(r), 0)
  if (required.length > 0) {
    for (const r of required) {
      const rt = r.toLowerCase().trim()
      if (!rt) continue
      const w = weightOf(r)
      const before = hits
      const isEnglish = rt === '英語' || rt === 'english' || rt.includes('英語')
      // skill_satisfies による判定（正規化＋包含関係＋語境界）。完全一致もここに含まれる
      if (satisfiedRequired?.has(r)) {
        if (isEnglish) {
          if (candidate.englishLevel === 'business') hits += 1.5
          else if (candidate.englishLevel === 'daily') hits += 0.8
          else hits += 1
        } else {
          hits += 1
        }
      } else if (cSet.has(rt)) {
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
      }
      // 旧ルールにあった双方向部分一致（`s.includes(rt) || rt.includes(s)` で +0.5）は
      // 廃止した。「C」が Microsoft 365 / Azure Functions に、「Shell」が PowerShell に
      // 合致して必須5中3合致と出る実害があった（2026-08-13）。
      // 表記ゆれ・包含関係は skill_satisfies（satisfiedRequired）が扱う
      if (hits > before) hitNames.push(r)
      hitWeight += (hits - before) * w
    }
  }
  // 歓迎（尚可）スキル: 一致ごとに +1pt。
  // 判定は必須と同じ skill_satisfies（satisfiedRequired には尚可スキルも入れて渡している）。
  // 旧ルールの双方向部分一致（+0.5pt）は必須側と同じ理由で廃止した。
  // 「C」が Microsoft 365 に、「Shell」が PowerShell に合致していた（2026-08-13）
  const niceToHave = project.niceToHaveSkills ?? []
  let niceHits = 0
  const niceHitNames: string[] = []
  if (niceToHave.length > 0) {
    for (const n of niceToHave) {
      const nt = n.toLowerCase().trim()
      if (!nt) continue
      if (satisfiedRequired?.has(n) || cSet.has(nt)) { niceHits += 1; niceHitNames.push(n) }
    }
  }
  // 重み付き比率。順位付けをする fetch_candidates_for_project と同じ式にする
  // （旧: hits / required.length。重みを無視していたため順位と表示スコアがズレていた）
  let skillRatio = required.length > 0 && totalWeight > 0
    ? Math.min(hitWeight / totalWeight, 1.0)
    : 0.5
  skillRatio = Math.min(1.0, skillRatio + (niceToHave.length > 0 ? niceHits / niceToHave.length * 0.1 : 0))
  const cappedSkillScore = Math.min(wSkill, Math.round(skillRatio * wSkill))
  // 尚可の充足は加点の根拠なので内訳に出す（スコアの根拠は画面で確認できるようにする）
  const niceDetail = niceToHave.length > 0
    ? `・尚可${niceToHave.length}中${niceHits}合致${niceHitNames.length > 0 ? `:${niceHitNames.join('・')}` : ''}`
    : ''
  const skillDetail = required.length > 0
    ? `スキル${cappedSkillScore}/${wSkill}(必須${required.length}中${Math.round(hits)}合致${hitNames.length > 0 ? `:${hitNames.join('・')}` : ''}${niceDetail})`
    : `スキル${cappedSkillScore}/${wSkill}(必須スキル未設定${niceDetail})`

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

  // 案件が必要年数を明示していれば「要件を満たすか」で採点する。
  // fetch_candidates_for_project は既にこの基準なのに、こちらは常に固定階段で
  // 案件要件を無視していた（2026-08-13）
  const reqExp = project.requiredExpYears
  let expRatio = 0
  let expBasis = ''
  if (typeof reqExp === 'number' && reqExp > 0) {
    expBasis = `・要${reqExp}年`
    if (exp == null) expRatio = 8.0 / 15.0
    else if (exp >= reqExp) expRatio = 1.0
    else if (exp >= reqExp - 1) expRatio = 8.0 / 15.0
    else if (exp >= reqExp - 2) expRatio = 4.0 / 15.0
    else expRatio = 0.0
  } else if (exp == null) expRatio = 5.0 / 15.0
  else if (exp >= 10) expRatio = 1.0
  else if (exp >= 7) expRatio = 12.0 / 15.0
  else if (exp >= 5) expRatio = 8.0 / 15.0
  else if (exp >= 3) expRatio = 4.0 / 15.0
  else if (exp >= 1) expRatio = 2.0 / 15.0
  const expScore = Math.round(expRatio * wExp)
  const expDetail = `経験${expScore}/${wExp}(${expLabel}${expBasis})`

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
  const projLoc = (project.workPrefecture ?? project.workLocation ?? '').toLowerCase()
  let locRatio = 0
  let locationDetail: string
  if (isFullRemote) {
    locRatio = 1.0
    locationDetail = `勤務地${wLoc}/${wLoc}(フルリモート)`
  } else if (projLoc) {
    const candPref = (candidate.prefecture ?? '').toLowerCase()
    const prefOnly = (candPref.match(/^(.+?[都道府県])/) ?? [])[1] ?? candPref.split(/[\s　]/)[0]
    const prefCore = prefOnly.replace(/[都道府県]$/, '')
    // 正規化済みの work_prefecture を優先する。無いときだけ work_location から切り出す
    const projPrefCoreForMatch = extractPrefCore(project.workPrefecture ?? project.workLocation ?? '')
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
  } else if (isFullRemote) {
    // フルリモート案件では勤務地が満点になる（場所を問わない）。
    // その上でリモート枠にも点を入れると同じ条件で二重に加点することになる。
    // 順位付けをする fetch_candidates_for_project も 0点にしているので合わせる
    remoteScore = 0
    remoteDetail = `リモート0/${wRemote}(フルリモート案件・勤務地で加点済み)`
  } else if (candidate.remoteAvailable == null) {
    // 人材側にリモートの記載が無い → 中間点。「不可」と断定しない
    // （断定すると、根拠が無いのに減点しているように見えて判定全体が疑われる）
    remoteScore = Math.round(wRemote * 0.5)
    remoteDetail = `リモート${Math.round(wRemote * 0.5)}/${wRemote}(人材側に記載なし)`
  } else {
    remoteScore = 0
    // 何を根拠に0点にしたかを書く。「不可」だけだと確認しようがない
    // false は「常駐可と明記」だけでなく、三値化前に取り込んだ古いレコードの既定値
    // でもある。断定せず「リモート可の記載がない」という事実だけを書く
    remoteDetail = `リモート0/${wRemote}(${candidate.remoteAvailable ? '可・案件側リモートなし' : 'リモート可の記載なし'})`
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
  // ── 雇用形態制限 ──
  let employmentTypeNote = ''
  if (project.allowedEmploymentTypes && project.allowedEmploymentTypes.length > 0) {
    const allowed = project.allowedEmploymentTypes
    if (candidate.employmentType) {
      if (!allowed.includes(candidate.employmentType)) {
        total = Math.min(total, 20)
        employmentTypeNote = ` [雇用形態NG(${candidate.employmentType})・20pt上限]`
      }
    } else {
      // 雇用形態不明 → 上限70pt
      total = Math.min(total, 70)
      employmentTypeNote = ' [雇用形態不明・70pt上限]'
    }
  }

  // ── 英語要件ボーナス ──
  let englishBonus = 0
  let englishNote = ''
  if (project.requiresEnglish && project.requiresEnglish !== 'none') {
    if (candidate.englishLevel === 'business') {
      englishBonus = project.requiresEnglish === 'native' ? 5 : 8
      englishNote = ` [英語要件+${englishBonus}pt(ビジネス)]`
    } else if (candidate.englishLevel === 'daily' && project.requiresEnglish === 'business') {
      englishBonus = 2
      englishNote = ' [英語要件+2pt(日常会話)]'
    }
    total = Math.min(110, total + englishBonus)
  }

  // ── 派遣免許確認済みボーナス ──
  let hakenLicenseNote = ''
  if (candidate.employmentType === '派遣社員') {
    if (candidate.hakenLicenseVerified === true) {
      total = Math.min(110, total + 5)
      hakenLicenseNote = ' [派遣免許確認済+5pt]'
    } else if (candidate.hakenLicenseVerified === false) {
      hakenLicenseNote = ' [派遣免許未確認]'
    }
  }

  // ── 役割の合致度（2026-08-14）──
  // 案件が求める役割（AI解釈）と人材の主役割を突き合わせる。
  // SQL 側 fetch_candidates_for_project の役割加減点と**同じ式・同じ重み**にすること。
  // ズレると「順位はAだが表示スコアはB」になる（配点は SQL / match-batch / フロントの
  // 3か所にあり、片方だけ直して事故った履歴がある。CLAUDE.md 参照）
  let roleNote = ''
  const requiredRole = project.requiredRole ?? null
  const mainRole = candidate.roles?.[0] ?? null
  if (requiredRole && mainRole) {
    const affinity = roleAffinity(requiredRole, mainRole)
    const delta = Math.round((affinity - 0.5) * ROLE_WEIGHT)
    if (delta !== 0) {
      total = Math.max(0, Math.min(110, total + delta))
      roleNote = ` [役割${delta > 0 ? '+' : ''}${delta}pt(要求:${requiredRole}／本人:${mainRole})]`
    }
  } else if (requiredRole && !mainRole) {
    roleNote = ` [役割不明(要求:${requiredRole})]`
  }

  const fullRemoteNote = (candidate.wantsFullRemote && !projectHasRemote) ? ' [フルリモート希望・常駐案件]' : ''
  const breakdown = `${skillDetail} ${expDetail} ${rateDetail} ${locationDetail} ${remoteDetail} → 計${total}pt${fullRemoteNote}${hakenNote}${employmentTypeNote}${englishNote}${hakenLicenseNote}${roleNote}`

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
    // 採点済みの breakdown をそのまま渡してAIが事実記述できるようにする。
    // ここで calcRuleScore を呼び直すと skill_satisfies の判定結果を持たないぶん
    // 保存される内訳と食い違うため、算出済みのものを使う
    const breakdown = c.ruleBreakdown ?? calcRuleScore(c, project).breakdown
    return (
      `[${i + 1}] id="${c.id}" score=${c.ruleScore} breakdown="${breakdown}"` +
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

必ず候補者全員（${candidates.length}名）分のエントリを返すこと。省略・途中終了禁止。
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

      // 必須スキルの充足判定を1往復でまとめて取る（判定は skill_satisfies に一本化）。
      // 尚可スキルも同じ往復で判定する（別に呼ぶと往復が倍になる）
      const satisfiedMap = await fetchSatisfiedRequired(
        (candidates as CandidateInput[]).map(c => c.skills ?? []),
        [...new Set([
          ...((projectRequirements as ProjectReq).requiredSkills ?? []),
          ...((projectRequirements as ProjectReq).niceToHaveSkills ?? []),
        ])],
      )
      // ルールスコアで全員採点 → ソート
      const scored = candidates.map((c, i) => {
        const r = calcRuleScore(c, projectRequirements, weights, satisfiedMap ? (satisfiedMap.get(i) ?? new Set<string>()) : null)
        return { ...c, ruleScore: r.total, ruleBreakdown: r.breakdown }
      })
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

      // 1人 × 複数案件。全案件の必須スキルを合わせて1往復で判定し、案件ごとに絞って渡す
      // （案件ごとに呼ぶと案件数ぶん往復する）
      const allWant = [...new Set((projects as ProjectReq[]).flatMap(
        p => [...(p.requiredSkills ?? []), ...(p.niceToHaveSkills ?? [])],
      ))]
      const satisfiedOne = await fetchSatisfiedRequired([(candidateProfile as CandidateInput).skills ?? []], allWant)
      const satisfiedSet = satisfiedOne ? (satisfiedOne.get(0) ?? new Set<string>()) : null
      const scored = projects.map(p => {
        const r = calcRuleScore(candidateProfile, p, weights, satisfiedSet)
        return { ...p, ruleScore: r.total, ruleBreakdown: r.breakdown }
      })
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
