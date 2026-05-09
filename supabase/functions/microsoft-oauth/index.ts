// Supabase Edge Function: microsoft-oauth
// Microsoft OAuth フローを処理する（authorize URL 生成 & コード交換）
//
// GET  ?step=start&account=<account>&redirect_uri=<uri>
//   → { authorizeUrl: string }
//
// POST body { step: 'callback', code: string, account: string, redirect_uri: string }
//   → { ok: true, account: string }
//
// 必要な Supabase Secrets:
//   GRAPH_CLIENT_ID           Azure ADアプリのクライアントID
//   GRAPH_CLIENT_SECRET       Azure ADアプリのクライアントシークレット
//   SUPABASE_URL              （自動設定）
//   SUPABASE_SERVICE_ROLE_KEY （自動設定）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID = Deno.env.get('GRAPH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const TENANT = 'consumers'
const SCOPE = 'offline_access Mail.Read Mail.ReadWrite'
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`
const AUTHORIZE_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`

/** account → app_config の key マッピング */
const CONFIG_KEY_MAP: Record<string, string> = {
  human_prod: 'graph_rt_human_prod',
  project_prod: 'graph_rt_project_prod',
  human_dev: 'graph_rt_human_dev',
  project_dev: 'graph_rt_project_dev',
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    if (req.method === 'GET') {
      return handleStart(req)
    }

    if (req.method === 'POST') {
      const body = await req.json()
      if (body?.step === 'callback') {
        return await handleCallback(body)
      }
      return errorResponse('不明な step です')
    }

    return errorResponse('サポートされていないHTTPメソッドです', 405)
  } catch (err) {
    console.error('[microsoft-oauth] 予期しないエラー:', err)
    return errorResponse(`サーバーエラー: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
})

/** step=start: Microsoft の authorize URL を生成して返す */
function handleStart(req: Request): Response {
  const url = new URL(req.url)
  const account = url.searchParams.get('account') ?? ''
  const redirectUri = url.searchParams.get('redirect_uri') ?? ''

  if (!account || !CONFIG_KEY_MAP[account]) {
    return errorResponse(`不明なアカウントです: ${account}`)
  }

  if (!redirectUri) {
    return errorResponse('redirect_uri が指定されていません')
  }

  if (!CLIENT_ID) {
    return errorResponse('GRAPH_CLIENT_ID が設定されていません', 500)
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: account,
    prompt: 'select_account', // 必ずアカウント選択画面を表示（キャッシュセッションをスキップ）
  })

  const authorizeUrl = `${AUTHORIZE_ENDPOINT}?${params.toString()}`
  return jsonResponse({ authorizeUrl })
}

/** step=callback: authorization code を token と交換し app_config に保存 */
async function handleCallback(body: {
  step: string
  code: string
  account: string
  redirect_uri: string
}): Promise<Response> {
  const { code, account, redirect_uri: redirectUri } = body

  if (!code) return errorResponse('code が指定されていません')
  if (!account || !CONFIG_KEY_MAP[account]) {
    return errorResponse(`不明なアカウントです: ${account}`)
  }
  if (!redirectUri) return errorResponse('redirect_uri が指定されていません')
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return errorResponse('GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET が設定されていません', 500)
  }

  // Microsoft に code → tokens を交換
  const tokenParams = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    console.error('[microsoft-oauth] token exchange failed:', errText)
    return errorResponse(`トークン交換に失敗しました: ${errText}`, 502)
  }

  const tokenData = await tokenRes.json()
  const refreshToken: string | undefined = tokenData.refresh_token

  if (!refreshToken) {
    return errorResponse('refresh_token が取得できませんでした（scope に offline_access が含まれているか確認してください）', 502)
  }

  // app_config に保存
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const configKey = CONFIG_KEY_MAP[account]

  const upsertRows = [
    { key: configKey, value: refreshToken },
    { key: `graph_connected_${account}`, value: '"true"' },
  ]

  const { error: upsertError } = await supabase
    .from('app_config')
    .upsert(upsertRows, { onConflict: 'key' })

  if (upsertError) {
    console.error('[microsoft-oauth] app_config upsert failed:', upsertError)
    return errorResponse(`DB保存に失敗しました: ${upsertError.message}`, 500)
  }

  console.log(`[microsoft-oauth] ${account} の連携が完了しました (configKey: ${configKey})`)
  return jsonResponse({ ok: true, account })
}
