// Supabase Edge Function: poll-email
// pg_cron から5分ごとに呼び出され、Outlook未読メールをGraph APIで取得して
// inbound-email Edge Function へ渡す（Make.com の代替）
//
// 必要な Supabase Secrets:
//   GRAPH_CLIENT_ID            Azure ADアプリのクライアントID
//   GRAPH_CLIENT_SECRET        Azure ADアプリのクライアントシークレット
//   GRAPH_REFRESH_TOKEN_HUMAN      human@outlook.jp (prod)
//   GRAPH_REFRESH_TOKEN_PROJECT    project@outlook.jp (prod)
//   GRAPH_REFRESH_TOKEN_HUMAN_DEV  human dev account (demo)
//   GRAPH_REFRESH_TOKEN_PROJECT_DEV project dev account (demo)
//   GEMINI_API_KEY             Gemini API キー（AI種別判断で使用）
//   SUPABASE_URL               （自動設定）
//   SUPABASE_SERVICE_ROLE_KEY  （自動設定）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.24.1'

const CLIENT_ID = Deno.env.get('GRAPH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const INBOUND_URL = `${SUPABASE_URL}/functions/v1/inbound-email`
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY') ?? ''
const GROQ_MODEL = 'llama-3.1-8b-instant'

/**
 * SUPABASE_SECRET_KEYS（新形式・JSON辞書）または
 * SUPABASE_SERVICE_ROLE_KEY（旧形式・DEPRECATED）から
 * inbound-email 呼び出し用の JWT を取得する
 */
function resolveCallKey(): string {
  // JWT形式（eyJ...）のキーを優先して使う
  // SUPABASE_SECRET_KEYS は sb_secret_ 形式でJWTではないためスキップ
  for (const key of ['INBOUND_CALL_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) {
    const val = Deno.env.get(key) ?? ''
    if (val.startsWith('eyJ')) return val
  }
  return ''
}

const CALL_KEY = resolveCallKey()

// 1回のポーリングで取得するメール上限
// 2,000通/日 ÷ 288ポーリング/日 ≈ 7通/回 → 余裕を持って20に設定
const MAX_EMAILS_PER_ACCOUNT = 20
// 全件取り込みモードでの1バッチあたりの取得上限
const MAX_EMAILS_PER_ACCOUNT_FULL = 20

// ---- ルールベース事前フィルター ----
// Gemini を呼ぶ前に件名・送信元で明らかなスパム/広告を除外（コスト削減）

/** これらのパターンを件名に含むメールは AI 判定なしでスキップ */
const SKIP_SUBJECT_PATTERNS = [
  /unsubscribe/i,
  /newsletter/i,
  /ニュースレター/,
  /メルマガ/,
  /お知らせ/,
  /ご案内/,
  /配信停止/,
  /登録完了/,
  /確認メール/,
  /noreply/i,
  /no-reply/i,
  /Invoice/i,
  /receipt/i,
  /領収書/,
  /請求書/,
  /支払い確認/,
  /サービス停止/,
  /メンテナンス/,
  /セキュリティ通知/,
  /password.*reset/i,
  /アカウント.*確認/,
  /ホームページより/,
  /HPより.*お問い合わせ/,
  /問い合わせフォーム/,
]

/**
 * 本文（HTML除去後）にこれらのパターンが含まれるメールはスキップ
 * 件名だけでは判別しにくい営業・スパムメールを本文で検知する
 */
const SKIP_BODY_PATTERNS = [
  /配信停止はこちら/,
  /テレアポ代行/,
  /テレアポ.*外注/,
  /営業代行.*強み/,
  /見込み顧客.*トスアップ/,
  /オンライン.*MTG.*ご状況/,
  /sales@[a-zA-Z0-9.]+\.[a-zA-Z]+/,   // 本文中に sales@xxx.com 形式の営業窓口メール
  /BtoB.*サービス.*ご案内/,
  /弊社.*サービス.*ご紹介/,
  /資料請求はこちら/,
  /日程調整URL.*https/,
  /timerex\.net/,                        // 日程調整サービス（テレアポ系でよく使われる）
  /ホームページより.*お客様からのお問い合わせ/,
  /【お問い合わせ区分】/,
  /【ご質問・ご相談内容】/,
]

/** これらのパターンを件名に含むメールは AI 判定なしで HR メールと確定 */
const HR_SUBJECT_PATTERNS = [
  /スキルシート/,
  /経歴書/,
  /エンジニア/,
  /フリーランス/,
  /案件/,
  /要件/,
  /参画/,
  /募集/,
  /求人/,
  /稼働/,
  /単価/,
  /常駐/,
  /開発者/,
  /SE[^O]/,
  /PG[^P]/,
  /PM[^S]/,
  /インフラ.*エンジ/,
  /Java.*開発/,
  /Python.*開発/,
  /React.*開発/,
  /Angular.*開発/,
  /Vue.*開発/,
  /AWS.*開発/,
  /Azure.*開発/,
  /クラウド.*案件/,
]

/**
 * ルールベースで事前フィルタリング（Gemini 不要）
 * 件名と本文（先頭1000文字）の両方を確認する
 * @returns 'skip' | 'candidate' | 'project' | 'unknown'
 */
function preFilterEmail(email: GraphMessage): 'skip' | 'candidate' | 'project' | 'unknown' {
  const subject = email.subject ?? ''
  const rawBody = email.body?.content ?? ''
  const plainBody = rawBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)

  // 件名でスキップ確定
  if (SKIP_SUBJECT_PATTERNS.some(p => p.test(subject))) {
    return 'skip'
  }

  // 本文でスキップ確定（営業・問い合わせフォーム通知など）
  if (SKIP_BODY_PATTERNS.some(p => p.test(plainBody))) {
    return 'skip'
  }

  // HR確定チェック（件名だけで明らかに候補者か案件）
  if (HR_SUBJECT_PATTERNS.some(p => p.test(subject))) {
    // 件名に「案件」「要件」「募集」「参画」「依頼」を含む場合は project
    if (/案件|要件|募集|参画|依頼|発注|プロジェクト/.test(subject)) return 'project'
    return 'candidate'
  }

  return 'unknown'
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ---- ポーリング対象アカウント定義 ----
interface PollConfig {
  secretKey: string             // Supabase Secret のキー名（初回）
  configKey: string             // app_config のキー名（ローテーション後）
  type: 'candidate' | 'project'
  dataEnv: 'prod' | 'demo'
}

const POLL_CONFIGS: PollConfig[] = [
  {
    secretKey:  'GRAPH_REFRESH_TOKEN_HUMAN',
    configKey:  'graph_rt_human_prod',
    type:       'candidate',
    dataEnv:    'prod',
  },
  {
    secretKey:  'GRAPH_REFRESH_TOKEN_PROJECT',
    configKey:  'graph_rt_project_prod',
    type:       'project',
    dataEnv:    'prod',
  },
  {
    secretKey:  'GRAPH_REFRESH_TOKEN_HUMAN_DEV',
    configKey:  'graph_rt_human_dev',
    type:       'candidate',
    dataEnv:    'demo',
  },
  {
    secretKey:  'GRAPH_REFRESH_TOKEN_PROJECT_DEV',
    configKey:  'graph_rt_project_dev',
    type:       'project',
    dataEnv:    'demo',
  },
]

// ---- app_config ヘルパー ----

async function getAppConfigValue(
  supabase: ReturnType<typeof createClient>,
  key: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  return data?.value ?? null
}

async function setAppConfigValue(
  supabase: ReturnType<typeof createClient>,
  key: string,
  value: string,
): Promise<void> {
  await supabase
    .from('app_config')
    .upsert({ key, value }, { onConflict: 'key' })
}

// ---- リフレッシュトークン管理 ----
// app_config を優先（ローテーション済みトークン）、なければ Secret にフォールバック

async function getRefreshToken(
  supabase: ReturnType<typeof createClient>,
  config: PollConfig,
): Promise<string> {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', config.configKey)
    .maybeSingle()

  if (data?.value) return data.value as string

  const secret = Deno.env.get(config.secretKey)
  if (!secret) throw new Error(`Secret "${config.secretKey}" が未設定です`)
  return secret
}

async function saveRefreshToken(
  supabase: ReturnType<typeof createClient>,
  configKey: string,
  token: string,
): Promise<void> {
  await supabase
    .from('app_config')
    .upsert({ key: configKey, value: token }, { onConflict: 'key' })
}

// ---- Microsoft Graph: アクセストークン取得 ----

async function getAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; newRefreshToken: string }> {
  const res = await fetch(
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
        scope:         'offline_access Mail.Read Mail.ReadWrite',
      }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`トークン取得失敗 (${res.status}): ${body}`)
  }

  const json = await res.json()
  return {
    accessToken:     json.access_token,
    newRefreshToken: json.refresh_token,
  }
}

// ---- Microsoft Graph: メール取得 ----

interface GraphMessage {
  id: string
  subject: string
  from: { emailAddress: { address: string; name: string } }
  body: { content: string; contentType: string }
  hasAttachments: boolean
  receivedDateTime: string
  isRead?: boolean
}

interface FetchEmailPageResult {
  emails: GraphMessage[]
  nextLink: string | null
}

async function fetchEmailPage(
  accessToken: string,
  mode: 'incremental' | 'full',
  since: string,
  nextLink?: string | null,
): Promise<FetchEmailPageResult> {
  let url: string

  if (mode === 'incremental') {
    // 既存の未読メール取得（変更なし）
    url = [
      'https://graph.microsoft.com/v1.0/me/messages',
      '?$filter=isRead eq false',
      `&$top=${MAX_EMAILS_PER_ACCOUNT}`,
      '&$select=id,subject,from,body,hasAttachments,receivedDateTime,isRead',
      '&$orderby=receivedDateTime asc',
    ].join('')
  } else if (nextLink) {
    // 全件モード: 続きのページ
    url = nextLink
  } else {
    // 全件モード: 最初のページ（isRead フィルターなし）
    const sinceDate = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    url = [
      'https://graph.microsoft.com/v1.0/me/messages',
      `?$top=${MAX_EMAILS_PER_ACCOUNT_FULL}`,
      `&$filter=receivedDateTime ge '${sinceDate}T00:00:00Z'`,
      '&$select=id,subject,from,body,hasAttachments,receivedDateTime,isRead',
      '&$orderby=receivedDateTime asc',
    ].join('')
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`メール取得失敗 (${res.status}): ${body}`)
  }

  const json = await res.json()
  const emails = (json.value ?? []) as GraphMessage[]
  const returnedNextLink = mode === 'full' ? (json['@odata.nextLink'] ?? null) : null

  // デバッグ: Graph APIの生レスポンス情報
  console.log(`[poll] fetchEmailPage: status=${res.status} value件数=${emails.length} error=${JSON.stringify(json.error ?? null)} url=${url.slice(0, 120)}`)

  return { emails, nextLink: returnedNextLink }
}

async function markAsRead(accessToken: string, messageId: string): Promise<void> {
  await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  })
}

async function markAsUnread(accessToken: string, messageId: string): Promise<void> {
  await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: false }),
  })
}

// ---- Microsoft Graph: 添付ファイル取得 ----

interface GraphAttachment {
  '@odata.type': string
  name: string
  contentType: string
  contentBytes: string
}

async function fetchAttachments(
  accessToken: string,
  messageId: string,
): Promise<GraphAttachment[]> {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return []
  const json = await res.json()
  return ((json.value ?? []) as GraphAttachment[]).filter(
    a => a['@odata.type'] === '#microsoft.graph.fileAttachment',
  )
}

// ---- AI 種別判断（Gemini）バッチ版 ----
// 複数メールをまとめて1回のGeminiコールで分類（コスト削減）

const BATCH_CLASSIFY_SIZE = 20 // 1回のAIコールで分類するメール数上限

/** バッチ分類プロンプトの解析（Groq・Gemini共通） */
function parseBatchClassifyResponse(text: string, emailCount: number): Array<'candidate' | 'project' | 'other'> {
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error(`AI応答がJSON配列でない: ${text.slice(0, 100)}`)
  const parsed = JSON.parse(jsonMatch[0]) as Array<{ i: number; t: string }>
  const typeMap = new Map<number, 'candidate' | 'project' | 'other'>()
  for (const item of parsed) {
    const t = item.t === 'project' ? 'project' : item.t === 'other' ? 'other' : 'candidate'
    typeMap.set(item.i, t)
  }
  return Array.from({ length: emailCount }, (_, i) => typeMap.get(i) ?? 'candidate')
}

async function classifyEmailsBatch(
  emails: GraphMessage[],
): Promise<Array<'candidate' | 'project' | 'other'>> {
  if (emails.length === 0) return []

  // メール一覧をテキスト化（本文は先頭200文字のみ・コスト削減）
  const emailList = emails.map((email, i) => {
    const rawBody = email.body?.content ?? ''
    const plainBody = rawBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return `[${i}] 件名: ${email.subject ?? '（なし）'}\n    本文: ${plainBody.slice(0, 200) || '（本文なし）'}`
  }).join('\n\n')

  const prompt = [
    `以下の${emails.length}件のメールを分類してください。`,
    '各メールを candidate / project / other の3種別で判断し、JSON配列だけを返してください。',
    '説明文・コードブロックは不要です。',
    '',
    '種別の定義:',
    '  candidate  - 人材・エンジニア・求職者・フリーランス本人の情報（スキルシート・経歴書・自己紹介・稼働確認など）',
    '             ※ 人名・連絡先があるだけでは candidate にしない。内容がHR情報か確認すること。',
    '  project    - 案件・プロジェクト・仕事依頼（要件定義・募集要項・単価・参画依頼など）',
    '  other      - 上記以外すべて。以下は必ず other:',
    '             ・営業メール・BtoBサービス案内（テレアポ代行・集客支援・マーケ支援・営業代行など）',
    '             ・ホームページ・フォームからの問い合わせ通知（「ホームページよりお問い合わせ」「【お問い合わせ区分】」等）',
    '             ・配信停止リンクを含む広告・メルマガ',
    '             ・サービス通知・システム通知・請求書・領収書',
    '             ・日程調整や資料請求への誘導が目的のメール',
    '',
    '返却形式: [{"i":0,"t":"candidate"},{"i":1,"t":"project"},...]',
    '',
    'メール一覧:',
    emailList,
  ].join('\n')

  const supabaseForLog = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const start = Date.now()
  let usedModel = 'gemini-2.5-flash-lite'
  let classifications: Array<'candidate' | 'project' | 'other'>

  // ---- Gemini で分類（精度重視・分類プロンプトは短いので低コスト）----
  if (true) {
    if (!GEMINI_API_KEY) {
      console.warn('[poll] GEMINI_API_KEY 未設定のため AI 分類をスキップ。candidate にフォールバック')
      return emails.map(() => 'candidate')
    }
    try {
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const resultPromise = model.generateContent(prompt)
      const result = await Promise.race([
        resultPromise,
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
        ),
      ])
      clearTimeout(timer)
      const text = (result as Awaited<typeof resultPromise>).response.text().trim()
      classifications = parseBatchClassifyResponse(text, emails.length)
      usedModel = 'gemini-2.5-flash-lite'
      console.log(`[poll] バッチ分類 Gemini成功 ${emails.length}件 durationMs=${Date.now() - start}`)
    } catch (e) {
      console.error(`[poll] バッチAI分類失敗: ${String(e)}。candidate にフォールバック`)
      return emails.map(() => 'candidate')
    }
  }

  // ---- ai_logs に記録 ----
  const durationMs = Date.now() - start
  supabaseForLog.from('ai_logs').insert({
    type: 'batch_classify',
    model: usedModel,
    ai_result: { count: emails.length, classifications },
    prompt_length: prompt.length,
    status: 'success',
    duration_ms: durationMs,
  }).then(({ error }) => {
    if (error) console.error('[poll] ai_logs insert失敗', error.message)
  })

  return classifications
}

// ---- inbound-email を呼び出し ----

async function callInboundEmail(
  email: GraphMessage,
  attachments: GraphAttachment[],
  type: 'candidate' | 'project',
  dataEnv: 'prod' | 'demo',
): Promise<void> {
  const payload = {
    type,
    data_env: dataEnv,
    from:     email.from?.emailAddress?.address ?? '',
    subject:  email.subject ?? '',
    body:     email.body?.content ?? '',
    // poll-email 側で既に分類済みのため inbound-email の関連度チェックをスキップ
    skip_relevance: true,
    attachments: attachments.map(a => ({
      name:     a.name,
      mimeType: a.contentType,
      data:     a.contentBytes,
    })),
  }

  const res = await fetch(INBOUND_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${CALL_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const json = await res.json().catch(() => ({}))
  console.log(`[poll] inbound-email 応答:`, json)
}

// ---- アカウント1件のポーリング処理 ----

interface PollAccountResult {
  processed: number
  skipped: number
  errors: string[]
  fullImportDone: boolean
}

async function pollAccount(
  supabase: ReturnType<typeof createClient>,
  config: PollConfig,
  mode: 'incremental' | 'full',
  useAiClassification: boolean,
  since: string,
): Promise<PollAccountResult> {
  let processed = 0
  let skipped = 0
  const errors: string[] = []
  let fullImportDone = false

  try {
    const refreshToken = await getRefreshToken(supabase, config)
    const { accessToken, newRefreshToken } = await getAccessToken(refreshToken)

    // リフレッシュトークンをローテーション保存
    await saveRefreshToken(supabase, config.configKey, newRefreshToken)

    // 全件モードの場合は保存済みの nextLink を取得
    let storedNextLink: string | null = null
    if (mode === 'full') {
      const nextLinkKey = `email_full_import_nextlink_${config.configKey}`
      const stored = await getAppConfigValue(supabase, nextLinkKey)
      if (stored === 'DONE') {
        // このアカウントは既に完了済み
        console.log(`[poll] ${config.configKey}: 全件取り込み完了済み`)
        fullImportDone = true
        return { processed, skipped, errors, fullImportDone }
      }
      storedNextLink = stored
    }

    // デバッグ: どのMicrosoftアカウントを見ているか確認
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const meJson = meRes.ok ? await meRes.json() : { _error: await meRes.text() }
    console.log(`[poll] ${config.configKey}: /me レスポンス =`, JSON.stringify(meJson))

    const { emails, nextLink } = await fetchEmailPage(accessToken, mode, since, storedNextLink)
    console.log(`[poll] ${config.configKey}: ${emails.length}件取得 (mode=${mode})`)

    // ---- ルールベース事前フィルター ----
    // Gemini を呼ぶ前に件名で明らかなスパムを除外
    const preFilterResults = emails.map(email => ({
      email,
      preResult: preFilterEmail(email),
    }))

    const ruleSkipped  = preFilterResults.filter(r => r.preResult === 'skip')
    const ruleResolved = preFilterResults.filter(r => r.preResult !== 'skip' && r.preResult !== 'unknown')
    const needAi       = preFilterResults.filter(r => r.preResult === 'unknown')

    // ルールでスキップ確定したものを既読にする
    for (const { email } of ruleSkipped) {
      try {
        if (mode === 'incremental') await markAsRead(accessToken, email.id)
        console.log(`[poll] 事前フィルタースキップ: "${email.subject}"`)
        skipped++
      } catch { /* ignore */ }
    }

    console.log(`[poll] ${config.configKey}: 事前フィルター結果 skip=${ruleSkipped.length} resolved=${ruleResolved.length} needAi=${needAi.length}`)

    // ---- バッチ AI 分類 ----
    // ルールで判定できなかったメールをまとめて1回のGeminiコールで分類
    const aiTypeMap = new Map<string, 'candidate' | 'project' | 'other'>()
    if (useAiClassification && needAi.length > 0) {
      for (let offset = 0; offset < needAi.length; offset += BATCH_CLASSIFY_SIZE) {
        const batch = needAi.slice(offset, offset + BATCH_CLASSIFY_SIZE)
        const types = await classifyEmailsBatch(batch.map(r => r.email))
        batch.forEach((r, i) => aiTypeMap.set(r.email.id, types[i]))
        console.log(`[poll] バッチ分類 ${offset}〜${offset + batch.length - 1}件完了`)
      }
    }

    // ---- メール処理 ----
    // ルール確定 + AI分類済みをまとめて処理
    const toProcess = [
      ...ruleResolved.map(r => ({ email: r.email, emailType: r.preResult as 'candidate' | 'project' })),
      ...needAi.map(r => {
        const aiType = aiTypeMap.get(r.email.id) ?? 'candidate'
        return { email: r.email, emailType: aiType as 'candidate' | 'project' | 'other' }
      }),
    ]

    for (const { email, emailType } of toProcess) {
      try {
        if (emailType === 'other') {
          if (mode === 'incremental') await markAsRead(accessToken, email.id)
          console.log(`[poll] スキップ (other): "${email.subject}" (${config.configKey})`)
          skipped++
          continue
        }

        const finalType: 'candidate' | 'project' = useAiClassification
          ? (emailType as 'candidate' | 'project')
          : config.type

        // 既読マーク（incremental: 二重処理防止 / full: 処理済みマーク）
        await markAsRead(accessToken, email.id)

        // 添付取得 → inbound-email へ渡す
        const attachments = email.hasAttachments
          ? await fetchAttachments(accessToken, email.id)
          : []

        console.log(`[poll] 添付: hasAttachments=${email.hasAttachments} 取得件数=${attachments.length}`, attachments.map(a => ({ name: a.name, type: a.contentType, bytesLen: a.contentBytes?.length ?? 0 })))

        await callInboundEmail(email, attachments, finalType, config.dataEnv)
        processed++
        console.log(`[poll] 処理完了: "${email.subject}" type=${finalType} (${config.configKey})`)
      } catch (e) {
        // 失敗したら未読に戻して次回ポーリングで再試行
        const msg = `メール処理失敗 "${email.subject}": ${String(e)}`
        console.error(`[poll] ${msg}`)
        errors.push(msg)
        try {
          await markAsUnread(accessToken, email.id)
          console.log(`[poll] 未読に戻しました: "${email.subject}"`)
        } catch (unreadErr) {
          console.error(`[poll] 未読戻し失敗: ${String(unreadErr)}`)
        }
      }
    }

    // 全件モードの nextLink 管理
    if (mode === 'full') {
      const nextLinkKey = `email_full_import_nextlink_${config.configKey}`
      if (nextLink) {
        // 次のページあり → 保存して次回継続
        await setAppConfigValue(supabase, nextLinkKey, nextLink)
        console.log(`[poll] ${config.configKey}: 次ページあり、nextLink 保存`)
      } else {
        // 最終ページ → 完了
        await setAppConfigValue(supabase, nextLinkKey, 'DONE')
        fullImportDone = true
        console.log(`[poll] ${config.configKey}: 全件取り込み完了`)
      }
    }

    if (emails.length === 0) skipped++
  } catch (e) {
    const msg = `アカウント処理失敗 (${config.configKey}): ${String(e)}`
    console.error(`[poll] ${msg}`)
    errors.push(msg)
  }

  return { processed, skipped, errors, fullImportDone }
}

// ---- エントリーポイント ----

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('GRAPH_CLIENT_ID または GRAPH_CLIENT_SECRET が未設定です')
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    console.log('[poll-email] 開始')

    // app_config からメール設定を読み込む
    const pollModeRaw = await getAppConfigValue(supabase, 'email_poll_mode')
    const mode: 'incremental' | 'full' | 'paused' =
      pollModeRaw === 'full' ? 'full' : pollModeRaw === 'paused' ? 'paused' : 'incremental'

    // 一時停止中はスキップ
    if (mode === 'paused') {
      console.log('[poll-email] 一時停止中のためスキップ')
      return new Response(
        JSON.stringify({ ok: true, mode: 'paused', totalProcessed: 0, totalErrors: [], summary: [] }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const useAiClassificationProd = (await getAppConfigValue(supabase, 'email_use_ai_classification')) === 'true'
    const useAiClassificationDev  = (await getAppConfigValue(supabase, 'email_use_ai_classification_dev')) === 'true'

    const since = (await getAppConfigValue(supabase, 'email_full_import_since')) ?? ''

    console.log(`[poll-email] mode=${mode}, useAiClassification prod=${useAiClassificationProd} dev=${useAiClassificationDev}`)

    // AI 種別判断有効時は candidate エントリーのみ（同一受信箱を2回処理しない）
    // prod・dev それぞれ独立して判断
    const targetConfigs = POLL_CONFIGS.filter(c => {
      const useAi = c.dataEnv === 'prod' ? useAiClassificationProd : useAiClassificationDev
      return !useAi || c.type === 'candidate'
    })

    // アカウントを並列処理
    const results = await Promise.allSettled(
      targetConfigs.map(config => {
        const useAiClassification = config.dataEnv === 'prod' ? useAiClassificationProd : useAiClassificationDev
        return pollAccount(supabase, config, mode, useAiClassification, since)
      }),
    )

    const summary = results.map((r, i) => ({
      account:   targetConfigs[i].configKey,
      dataEnv:   targetConfigs[i].dataEnv,
      type:      targetConfigs[i].type,
      ...(r.status === 'fulfilled'
        ? r.value
        : { processed: 0, skipped: 0, errors: [String(r.reason)], fullImportDone: false }),
    }))

    const totalProcessed = summary.reduce((s, r) => s + r.processed, 0)
    const totalErrors    = summary.flatMap(r => r.errors)

    // 全件モード完了チェック: 全アカウントが fullImportDone なら incremental に戻す
    if (mode === 'full') {
      const allDone = summary.every(r => r.fullImportDone)
      if (allDone) {
        await setAppConfigValue(supabase, 'email_poll_mode', 'incremental')
        // 全 nextLink キーをクリア
        for (const config of POLL_CONFIGS) {
          const nextLinkKey = `email_full_import_nextlink_${config.configKey}`
          await setAppConfigValue(supabase, nextLinkKey, '')
        }
        console.log('[poll-email] 全件取り込み完了 → incremental モードに戻しました')
      }
    }

    console.log(`[poll-email] 完了: ${totalProcessed}件処理, エラー ${totalErrors.length}件`)

    return new Response(
      JSON.stringify({ ok: true, mode, useAiClassificationProd, useAiClassificationDev, totalProcessed, totalErrors, summary }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[poll-email] 致命的エラー', e)
    // pg_cron が停止しないよう 200 を返す
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
