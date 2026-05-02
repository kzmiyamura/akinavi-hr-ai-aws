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
//   SUPABASE_URL               （自動設定）
//   SUPABASE_SERVICE_ROLE_KEY  （自動設定）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID = Deno.env.get('GRAPH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const INBOUND_URL = `${SUPABASE_URL}/functions/v1/inbound-email`

/**
 * SUPABASE_SECRET_KEYS（新形式・JSON辞書）または
 * SUPABASE_SERVICE_ROLE_KEY（旧形式・DEPRECATED）から
 * inbound-email 呼び出し用の JWT を取得する
 */
function resolveCallKey(): string {
  // 新形式: {"default": "<jwt>"} または {"<name>": "<jwt>"}
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS') ?? ''
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys)
      if (typeof parsed === 'object' && parsed !== null) {
        const first = Object.values(parsed)[0]
        if (typeof first === 'string' && first) return first
      }
    } catch { /* JSON でなければ素の文字列として使用 */ }
    if (secretKeys) return secretKeys
  }
  // 旧形式フォールバック
  return SERVICE_ROLE_KEY || Deno.env.get('SUPABASE_ANON_KEY') || ''
}

const CALL_KEY = resolveCallKey()

// デバッグ用（確認後削除）
console.log('[poll-email] CALL_KEY 先頭10文字:', CALL_KEY.slice(0, 10) || '(空)')
console.log('[poll-email] SUPABASE_SECRET_KEYS 存在:', !!Deno.env.get('SUPABASE_SECRET_KEYS'))
console.log('[poll-email] SUPABASE_SERVICE_ROLE_KEY 存在:', !!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
console.log('[poll-email] SUPABASE_ANON_KEY 存在:', !!Deno.env.get('SUPABASE_ANON_KEY'))

// 1回のポーリングで取得するメール上限（タイムアウト対策）
const MAX_EMAILS_PER_ACCOUNT = 3

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
}

async function fetchUnreadEmails(accessToken: string): Promise<GraphMessage[]> {
  const url = [
    'https://graph.microsoft.com/v1.0/me/messages',
    '?$filter=isRead eq false',
    `&$top=${MAX_EMAILS_PER_ACCOUNT}`,
    '&$select=id,subject,from,body,hasAttachments,receivedDateTime',
    '&$orderby=receivedDateTime asc',
  ].join('')

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`メール取得失敗 (${res.status}): ${body}`)
  }

  const json = await res.json()
  return (json.value ?? []) as GraphMessage[]
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

async function pollAccount(
  supabase: ReturnType<typeof createClient>,
  config: PollConfig,
): Promise<{ processed: number; skipped: number; errors: string[] }> {
  let processed = 0
  let skipped = 0
  const errors: string[] = []

  try {
    const refreshToken = await getRefreshToken(supabase, config)
    const { accessToken, newRefreshToken } = await getAccessToken(refreshToken)

    // リフレッシュトークンをローテーション保存
    await saveRefreshToken(supabase, config.configKey, newRefreshToken)

    const emails = await fetchUnreadEmails(accessToken)
    console.log(`[poll] ${config.configKey}: 未読 ${emails.length}件`)

    for (const email of emails) {
      try {
        // 1. 先に既読マーク（二重処理防止）
        await markAsRead(accessToken, email.id)

        // 2. 添付取得 → inbound-email へ渡す
        const attachments = email.hasAttachments
          ? await fetchAttachments(accessToken, email.id)
          : []

        await callInboundEmail(email, attachments, config.type, config.dataEnv)
        processed++
        console.log(`[poll] 処理完了: "${email.subject}" (${config.configKey})`)
      } catch (e) {
        // 3. 失敗したら未読に戻して次回ポーリングで再試行
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

    if (emails.length === 0) skipped++
  } catch (e) {
    const msg = `アカウント処理失敗 (${config.configKey}): ${String(e)}`
    console.error(`[poll] ${msg}`)
    errors.push(msg)
  }

  return { processed, skipped, errors }
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

    // 4アカウントを並列処理
    const results = await Promise.allSettled(
      POLL_CONFIGS.map(config => pollAccount(supabase, config)),
    )

    const summary = results.map((r, i) => ({
      account:   POLL_CONFIGS[i].configKey,
      dataEnv:   POLL_CONFIGS[i].dataEnv,
      type:      POLL_CONFIGS[i].type,
      ...(r.status === 'fulfilled'
        ? r.value
        : { processed: 0, skipped: 0, errors: [String(r.reason)] }),
    }))

    const totalProcessed = summary.reduce((s, r) => s + r.processed, 0)
    const totalErrors    = summary.flatMap(r => r.errors)

    console.log(`[poll-email] 完了: ${totalProcessed}件処理, エラー ${totalErrors.length}件`)

    return new Response(
      JSON.stringify({ ok: true, totalProcessed, totalErrors, summary }),
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
