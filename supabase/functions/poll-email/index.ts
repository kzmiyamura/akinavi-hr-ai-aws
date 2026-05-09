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

// 1回のポーリングで取得するメール上限（タイムアウト対策）
const MAX_EMAILS_PER_ACCOUNT = 3
// 全件取り込みモードでの1バッチあたりの取得上限
const MAX_EMAILS_PER_ACCOUNT_FULL = 20

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

// ---- AI 種別判断（Gemini） ----

async function classifyEmailType(
  email: GraphMessage,
): Promise<'candidate' | 'project' | 'other'> {
  if (!GEMINI_API_KEY) {
    console.warn('[poll] GEMINI_API_KEY 未設定のため AI 分類をスキップ。candidate にフォールバック')
    return 'candidate'
  }

  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

    const prompt = [
      'このメールの種別を判断してください。',
      '以下の3種別から1つだけ返してください（他の文字列は不要）:',
      '  candidate  - 人材・エンジニア・求職者の情報（スキルシート・経歴書・自己紹介など）',
      '  project    - 案件・プロジェクト・仕事依頼（要件定義・募集要項・単価など）',
      '  other      - 上記どちらでもない（広告・通知・スパムなど）',
      '',
      `件名: ${email.subject ?? ''}`,
      `本文（先頭500文字）: ${(email.body?.content ?? '').slice(0, 500)}`,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    const resultPromise = model.generateContent(prompt)
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
      ),
    ])
    clearTimeout(timer)

    const text = (result as Awaited<typeof resultPromise>)
      .response.text().trim().toLowerCase()

    if (text === 'project') return 'project'
    if (text === 'other') return 'other'
    return 'candidate'
  } catch (e) {
    console.error(`[poll] AI 分類失敗: ${String(e)}。candidate にフォールバック`)
    return 'candidate'
  }
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

    const { emails, nextLink } = await fetchEmailPage(accessToken, mode, since, storedNextLink)
    console.log(`[poll] ${config.configKey}: ${emails.length}件取得 (mode=${mode})`)

    for (const email of emails) {
      try {
        // AI 種別判断
        let emailType: 'candidate' | 'project' = config.type
        if (useAiClassification) {
          const aiType = await classifyEmailType(email)
          if (aiType === 'other') {
            // 'other' はスキップ（既読にして次へ）
            if (mode === 'incremental') {
              await markAsRead(accessToken, email.id)
            }
            console.log(`[poll] スキップ (other): "${email.subject}" (${config.configKey})`)
            skipped++
            continue
          }
          emailType = aiType
          console.log(`[poll] AI 分類: "${email.subject}" → ${aiType}`)
        }

        // 既読マーク（incremental: 二重処理防止 / full: 処理済みマーク）
        await markAsRead(accessToken, email.id)

        // 添付取得 → inbound-email へ渡す
        const attachments = email.hasAttachments
          ? await fetchAttachments(accessToken, email.id)
          : []

        await callInboundEmail(email, attachments, emailType, config.dataEnv)
        processed++
        console.log(`[poll] 処理完了: "${email.subject}" (${config.configKey})`)
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
      JSON.stringify({ ok: true, mode, useAiClassification, totalProcessed, totalErrors, summary }),
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
