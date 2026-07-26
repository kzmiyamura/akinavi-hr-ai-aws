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

// 1回のポーリングで取得するメール上限（AI解析廃止により高速化→50に拡大）
// ★段階公開Phase1(2026-07-26): 13,335件のバックログを安全に消化するため20に設定。
//   Storage/egress監視で安定を確認したら50へ。異常時は1に戻す
const MAX_EMAILS_PER_ACCOUNT = 20
// 全件取り込みモードでの1バッチあたりの取得上限
const MAX_EMAILS_PER_ACCOUNT_FULL = 50

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
  /勤怠実績通知/,
  /e-staffing/i,
  /自動配信メール/,
  /システム通知/,
  // 打ち合わせ・日程調整系
  /打ち?合わせ/,
  /ミーティング/,
  /面談.*日程/,
  /日程.*面談/,
  /日程調整/,
  /スケジュール調整/,
  /お時間.*いただけ/,
  /MTG.*依頼/i,
  /meeting.*request/i,
  // 退職・異動挨拶（2026-07-05追加）
  /退職のご挨拶/,
  /退職.*挨拶/,
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
  // 勤怠・派遣管理システム通知
  /このメールはシステムからの自動配信メール/,
  /返信いただけませんので.*ご了承/,
  /勤怠実績通知/,
  /派遣先企業より.*勤怠/,
  /e-staffing\.ne\.jp/,
  /e-staffing\.co\.jp/,
  /スタッフコード[：:]/,
  /就業先企業名[：:]/,
  /派遣先管理台帳/,
  // その他自動配信・システム通知
  /このメールへの返信はできません/,
  /このメールは自動送信されています/,
  /自動送信メールのため.*返信.*できません/,
  /portal\.[a-zA-Z0-9.-]+\/agency\//,   // 派遣管理ポータルURL
  // LinkedIn採用サービス営業（2026-07-05追加）
  /LinkedIn.*活用.*採用/,
  /LinkedInを活用した/,
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

// ---- ルールベース案件判定パターン ----

/** 件名にこれらのパターンが含まれる場合は project と判定 */
const PROJECT_SUBJECT_PATTERNS = [
  /【案件/,
  /案件情報/,
  /案件のご紹介/,
  /案件ご紹介/,
  /ご案件/,
  /開発案件/,
  /スキルチェック/,
  /要員募集/,
  /人材募集/,
  /エンジニア募集/,
  /SE.*急募/,
  /エンジニア.*急募/,
  /求人/,
  /更改/,      // システム更改・ミドルウェア更改など
  /リニューアル/,
  /リプレイス/,
  /構築.*案件/,
  /移行.*案件/,
]

/** 本文冒頭500文字にこれらのパターンが含まれる場合は project と判定 */
const PROJECT_BODY_PATTERNS = [
  /【案件情報】/,
  /案件名[：:]/,
  /必須スキル[：:]/,
  /参画時期[：:]/,
  /募集人数[：:]/,
  /単価[：:]\s*[\d～〜]/,
  /契約形態[：:]/,
  /精算幅[：:]/,
  /清算幅[：:]/,
  /稼働開始[：:]/,
  /就業場所[：:]/,
  /作業場所[：:]/,
  /勤務地[：:]/,
  /商流[：:]/,
  /管理ID[：:]/,
  /ご提案をお待ち/,
  /合う人材がいれば/,
  /見合う方がいれば/,
  /人材をお持ちであれば/,
  /人材を探して/,
  // 【商　流】【精　算】【人　数】【面　談】など全角スペース入り案件フィールド
  /【商[\s　]*流】/,
  /【精[\s　]*算】/,
  /【人[\s　]*数】/,
  /【面[\s　]*談】/,
  /【期[\s　]*間】.*\d{4}/,  // 【期　間】2027年 のような案件期間
  // 「見合う要員様がいれば提案を」系の文言
  /見合う要員/,
  /ご提案いただけますと/,
  /ご紹介いただけますと/,
  /要員のご提案/,
  /ご提案.*幸い/,
  // 案件紹介メール特有フレーズ
  /案件のご紹介/,
  /弊社案件/,
  /ご紹介の案件/,
  /要員をお探し/,
  /ご要員がいれば/,
  /ご提案いただける/,
  /該当する方がいらっしゃいましたら/,
  /ご検討いただける人材/,
  /お力添えをいただけますか/,
  /ご参画いただける方/,
  // 案件紹介一斉配信メール（三鋭システム等）
  /表記の件について、ご紹介いたします/,
  // Uniquery等の「見合う方がいれば提案を」パターン
  /見合う方がおりましたらご提案/,
]

/**
 * ルールベースで案件メールか判定する
 * 件名と本文冒頭500文字を対象とする
 */
function isProjectByRuleBase(subject: string, plainBody500: string): boolean {
  // 件名パターン
  if (PROJECT_SUBJECT_PATTERNS.some(p => p.test(subject))) return true
  // 本文パターン
  if (PROJECT_BODY_PATTERNS.some(p => p.test(plainBody500))) return true
  return false
}

/**
 * ルールベースで事前フィルタリング（Gemini 不要）
 * 件名と本文（先頭1000文字）の両方を確認する
 * @returns 'skip' | 'candidate' | 'project' | 'unknown'
 */
function preFilterEmail(email: GraphMessage): 'skip' | 'candidate' | 'project' | 'unknown' {
  const subject = email.subject ?? ''
  const rawBody = email.body?.content ?? ''
  const plainBody = rawBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
  const plainBody500 = plainBody.slice(0, 500)

  // 件名でスキップ確定
  if (SKIP_SUBJECT_PATTERNS.some(p => p.test(subject))) {
    return 'skip'
  }

  // 本文でスキップ確定（営業・問い合わせフォーム通知など）
  if (SKIP_BODY_PATTERNS.some(p => p.test(plainBody))) {
    return 'skip'
  }

  // 件名だけで案件確定のパターン（HR判定前に先にチェック）
  if (/エンド直|直案件|直\s*案件|合う人材|ご紹介をお待ち|エンドユーザー.*直/.test(subject)) return 'project'

  // ルールベース案件判定（件名＋本文冒頭500文字）
  // → AI分類より前に実施し、明確な案件メールを確実に project と判定
  if (isProjectByRuleBase(subject, plainBody500)) return 'project'

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
  mode: 'incremental' | 'full' | 'recover',
  since: string,
  nextLink?: string | null,
): Promise<FetchEmailPageResult> {
  let url: string

  if (mode === 'recover') {
    // 復旧モード: 処理後に削除（=削除済みアイテムへ移動）されたメールを、
    // 「削除済みアイテム」フォルダから since 以降で読み直す。既読/削除の副作用は起こさない。
    const sinceDate = since || new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    url = [
      'https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems/messages',
      `?$top=${MAX_EMAILS_PER_ACCOUNT_FULL}`,
      `&$filter=receivedDateTime ge '${sinceDate}T00:00:00Z'`,
      '&$select=id,subject,from,body,hasAttachments,receivedDateTime,isRead',
      '&$orderby=receivedDateTime asc',
    ].join('')
  } else if (mode === 'incremental') {
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

async function deleteMessage(accessToken: string, messageId: string): Promise<void> {
  await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
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

/**
 * Graph が返す添付の「完全な内訳」をメタデータのみ（contentBytes を落とさない=egress最小）で取得する。
 * fetchAttachments は fileAttachment だけを通すため、referenceAttachment（OneDrive/SharePoint等の
 * クラウド添付）やitemAttachmentが「取得前に消える」と原因調査ができない実害があった。
 * ここで型を含めた台帳をDBに残すことで「Graphが実際に何を何個返したか」を後から必ず確認できる。
 */
async function fetchAttachmentManifest(
  accessToken: string,
  messageId: string,
): Promise<Array<{ name: string; contentType: string; odataType: string; size: number }>> {
  // $select で contentBytes を除外（bytes をダウンロードしないので egress ほぼゼロ）
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments?$select=id,name,contentType,size,isInline`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) return []
  const json = await res.json()
  return ((json.value ?? []) as Array<Record<string, unknown>>).map(a => ({
    name: String(a.name ?? ''),
    contentType: String(a.contentType ?? ''),
    odataType: String(a['@odata.type'] ?? ''),
    size: Number(a.size ?? 0),
  }))
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
    '',
    '【candidate】送り主が「うちの人材を使ってください」と紹介するメール',
    '  ・人材会社・SES会社・フリーランス本人が、特定の人材を売り込んでいる',
    '  ・スキルシート・経歴書・自己紹介・稼働確認・要員ご紹介など',
    '  ・「直要員」「ご要員」「即日参画可」「弊社エンジニア」「スキルシート添付」',
    '  ・件名にスキル名が並んでいても、人材を売り込む内容なら candidate',
    '  ※ 人名・連絡先があるだけでは candidate にしない',
    '',
    '【project】送り主が「あなたの人材を紹介してください」と依頼するメール',
    '  ・案件紹介会社・エンド企業が、受け取り側に候補者の提案を求めている',
    '  ・「ご提案をお待ちしております」「合う人材がいればご紹介ください」',
    '  ・「人材を募集しております」「見合う方がいれば」',
    '  ・必須スキル/尚可スキル・金額・清算・面談回数などの案件条件が記載されている',
    '  ・「管理ID」「エンド直」「商流」「清算幅」などの案件管理用語がある',
    '  ・件名に【エンド直】【急募】【直案件】などがあれば project の可能性が高い',
    '',
    '【other】上記以外。以下は必ず other:',
    '  ・営業メール・BtoBサービス案内（テレアポ代行・集客支援・マーケ支援・営業代行など）',
    '  ・ホームページ・フォームからの問い合わせ通知',
    '  ・配信停止リンクのみ含む広告・メルマガ（ただし案件紹介メールにも配信停止リンクが付く場合があるので注意）',
    '  ・サービス通知・システム通知・請求書・領収書',
    '  ・日程調整や資料請求への誘導が目的のメール',
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

// ---- Officeファイル添付判定 ----

const OFFICE_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',     // .xlsx
  'application/vnd.ms-excel',                                               // .xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword',                                                     // .doc
])

const OFFICE_EXTENSIONS = /\.(xlsx?|docx?)$/i

/** ExcelまたはWordの添付ファイルか判定 */
function isOfficeAttachment(att: GraphAttachment): boolean {
  if (OFFICE_MIME_TYPES.has(att.contentType)) return true
  if (OFFICE_EXTENSIONS.test(att.name ?? '')) return true
  return false
}

// ---- inbound-email を呼び出し ----

async function callInboundEmail(
  email: GraphMessage,
  attachments: GraphAttachment[],
  type: 'candidate' | 'project',
  dataEnv: 'prod' | 'demo',
  dedupSalt = '',
): Promise<void> {
  const payload = {
    type,
    data_env: dataEnv,
    from:     email.from?.emailAddress?.address ?? '',
    subject:  email.subject ?? '',
    body:     email.body?.content ?? '',
    // Outlookがメールを受信した実際の日時（解析完了時刻=created_atとは別）
    email_received_at: email.receivedDateTime ?? null,
    // poll-email 側でルールフィルター・AI分類済みだが、Lambda門番（Bedrock）も通す
    skip_relevance: false,
    // 添付分割時に各呼び出しを区別（inbound-email のデdup判定で使用）
    dedup_salt: dedupSalt,
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
  mode: 'incremental' | 'full' | 'recover',
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

    // ルールでスキップ確定したものを削除
    for (const { email } of ruleSkipped) {
      try {
        if (mode === 'incremental') await deleteMessage(accessToken, email.id)
        console.log(`[poll] 事前フィルタースキップ・削除: "${email.subject}"`)
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
          if (mode === 'incremental') await deleteMessage(accessToken, email.id)
          console.log(`[poll] スキップ・削除 (other): "${email.subject}" (${config.configKey})`)
          skipped++
          continue
        }

        // 優先度: (1) AI分類結果 → (2) ルールベース案件判定 → (3) config.type デフォルト
        let finalType: 'candidate' | 'project'
        if (useAiClassification) {
          finalType = emailType as 'candidate' | 'project'
        } else {
          // AI分類が無効の場合でも、ルールベースで案件と判定できるなら project にする
          const rawBody2 = email.body?.content ?? ''
          const plainBody500 = rawBody2.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
          if (isProjectByRuleBase(email.subject ?? '', plainBody500)) {
            finalType = 'project'
            console.log(`[poll] ルールベース案件判定 (AI無効フォールバック): "${email.subject}"`)
          } else {
            finalType = config.type
          }
        }

        // 処理中の二重取得防止のため先に既読マーク（処理完了後に削除）
        // 復旧モードは削除済みアイテムを読むだけなので既読化しない（副作用ゼロ）
        if (mode !== 'recover') await markAsRead(accessToken, email.id)

        // 添付取得 → inbound-email へ渡す
        const attachments = email.hasAttachments
          ? await fetchAttachments(accessToken, email.id)
          : []

        console.log(`[poll] 添付: hasAttachments=${email.hasAttachments} 取得件数=${attachments.length}`, attachments.map(a => ({ name: a.name, type: a.contentType, bytesLen: a.contentBytes?.length ?? 0 })))

        // ── 添付台帳を DB に恒久記録（Graphが返した完全な内訳・型込み） ──
        // fetchAttachments が落とす referenceAttachment（クラウド添付）も含めて記録し、
        // 「何があってもログで確認できる」ようにする。bytes は取得しないので egress は無視できる。
        if (email.hasAttachments) {
          try {
            const manifest = await fetchAttachmentManifest(accessToken, email.id)
            const fileCount = manifest.filter(m => m.odataType === '#microsoft.graph.fileAttachment').length
            const refCount = manifest.filter(m => m.odataType === '#microsoft.graph.referenceAttachment').length
            const itemCount = manifest.filter(m => m.odataType === '#microsoft.graph.itemAttachment').length
            const droppedCount = manifest.length - attachments.length
            console.log(`[poll] 添付台帳: total=${manifest.length} file=${fileCount} ref=${refCount} item=${itemCount} 渡した=${attachments.length} 捨てた=${droppedCount}`)
            await supabase.from('ai_logs').insert({
              type: 'poll-attach',
              model: 'no-ai',
              from_address: email.from?.emailAddress?.address ?? '',
              subject: email.subject ?? '',
              // status は CHECK制約で success/error のみ。落とした添付があれば error にして目立たせる
              status: droppedCount > 0 ? 'error' : 'success',
              error_message: droppedCount > 0 ? `Graph添付${manifest.length}件中${droppedCount}件をinboundに渡せず（ref/item等）` : null,
              ai_result: {
                messageId: email.id,
                totalReturnedByGraph: manifest.length,
                fileAttachment: fileCount,
                referenceAttachment: refCount,
                itemAttachment: itemCount,
                passedToInbound: attachments.length,
                dropped: droppedCount,
                manifest: manifest.map(m => ({ name: m.name, type: m.odataType.replace('#microsoft.graph.', ''), contentType: m.contentType, size: m.size })),
              },
            })
          } catch (logErr) {
            console.error(`[poll] 添付台帳の記録失敗: ${String(logErr)}`)
          }
        }

        // 人材メールに Office 添付が複数ある場合は1ファイル=1候補者として分割処理
        const officeAtts = attachments.filter(isOfficeAttachment)
        if (finalType === 'candidate' && officeAtts.length >= 2) {
          console.log(`[poll] 添付分割モード: Office添付${officeAtts.length}件 → ${officeAtts.length}回 inbound-email 呼び出し`)
          const nonOfficeAtts = attachments.filter(a => !isOfficeAttachment(a))
          for (let si = 0; si < officeAtts.length; si++) {
            const officeAtt = officeAtts[si]
            // 2件目以降は Groq/Gemini のレート制限を避けるため 5 秒待機
            if (si > 0) await new Promise(r => setTimeout(r, 5000))
            // 本文(email body) + 非Officeファイル（画像等）は全件に共通して渡す
            // dedup_salt に "メッセージID_添付ファイル名" を使用
            // email.id (Outlook メッセージID) を含めることで添付名が変わっても同一メールをdedup可能
            await callInboundEmail(email, [...nonOfficeAtts, officeAtt], finalType, config.dataEnv, `${email.id}_${officeAtt.name ?? si}`)
            console.log(`[poll] 添付分割: "${officeAtt.name}" 登録完了`)
          }
        } else {
          await callInboundEmail(email, attachments, finalType, config.dataEnv)
        }
        processed++
        // 処理完了後にメールを削除（DB に保存済みのため Outlook 側は不要）
        // 復旧モードは削除済みアイテムの再処理なので二重削除しない（そのまま残す）
        if (mode !== 'recover') {
          try { await deleteMessage(accessToken, email.id) } catch { /* ignore */ }
        }
        console.log(`[poll] 処理完了${mode === 'recover' ? '(復旧・非削除)' : '・削除'}: "${email.subject}" type=${finalType} (${config.configKey})`)
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

    // ---- 排他ロック（二重起動防止） ----
    // 前のポーリングがまだ動いている場合はスキップ（タイムアウト: 8分）
    const LOCK_KEY = 'poll_email_lock'
    const LOCK_TIMEOUT_MS = 8 * 60 * 1000
    const { data: lockRow } = await supabase.from('app_config').select('value').eq('key', LOCK_KEY).maybeSingle()
    if (lockRow?.value) {
      const lockedAt = new Date(lockRow.value).getTime()
      if (Date.now() - lockedAt < LOCK_TIMEOUT_MS) {
        const elapsedSec = Math.round((Date.now() - lockedAt) / 1000)
        console.log(`[poll-email] 前回のポーリングが実行中のためスキップ (${elapsedSec}秒前に開始)`)
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: 'LOCKED', lockedAtSec: elapsedSec }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        )
      }
    }
    await supabase.from('app_config').upsert({ key: LOCK_KEY, value: new Date().toISOString() }, { onConflict: 'key' })

    console.log('[poll-email] 開始')

    // app_config からメール設定を読み込む
    const pollModeRaw = await getAppConfigValue(supabase, 'email_poll_mode')
    const mode: 'incremental' | 'full' | 'recover' | 'paused' =
      pollModeRaw === 'full' ? 'full'
        : pollModeRaw === 'recover' ? 'recover'
          : pollModeRaw === 'paused' ? 'paused' : 'incremental'

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

    // 復旧モードは1回きり。実行後は必ず incremental に戻す（暴発防止）
    if (mode === 'recover') {
      await setAppConfigValue(supabase, 'email_poll_mode', 'incremental')
      console.log('[poll-email] 復旧モード完了 → incremental に戻しました')
    }

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

    // ロック解除
    await supabase.from('app_config').delete().eq('key', LOCK_KEY)

    return new Response(
      JSON.stringify({ ok: true, mode, useAiClassificationProd, useAiClassificationDev, totalProcessed, totalErrors, summary }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    console.error('[poll-email] 致命的エラー', e)
    // ロック解除（エラー時も確実に）
    try {
      const supabaseForUnlock = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
      await supabaseForUnlock.from('app_config').delete().eq('key', 'poll_email_lock')
    } catch { /* ignore */ }
    // pg_cron が停止しないよう 200 を返す
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
