/**
 * Lambda Function: gate-filter（門番フィルター）
 *
 * メールの先頭 ~600 文字を受け取り、HR/案件マッチングに関係するかを判定する。
 *
 * 【最適化】キーワードスコアリングで明確なケースは Bedrock 不使用:
 *   スコア >= 4  → "1"（明確な HR メール）
 *   スコア <= -3 → "0"（明確なスパム/無関係）
 *   中間         → Bedrock Claude 3 Haiku で判定（曖昧なケースのみ）
 *
 * 入力 (POST JSON):  { text: string }
 * 出力 (JSON):       { result: "1" | "0", method?: "rule" | "ai" }
 *
 * 認証: x-api-key ヘッダー（LAMBDA_API_KEY 環境変数と照合）
 * フェイルオープン: エラー時は "1" を返し処理を続行させる
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { invokeHaiku } from '../../shared/bedrockClient'

const ALLOWED_KEY = process.env.LAMBDA_API_KEY ?? ''

// ── キーワードスコアリング ─────────────────────────────────────────────────

/** HR/案件関連キーワード（検出で +2点） */
const HR_POSITIVE_KEYWORDS = [
  // 人材
  'スキルシート', '職務経歴', '経歴書', '履歴書', '人材', '候補者', '要員', '即日',
  'エンジニア', 'プログラマ', 'デザイナー', 'インフラ', 'フリーランス',
  // 案件
  '案件', '業務委託', '単価', '稼働', '参画', '募集', '要件', 'エンド直', '直案件',
  '必須スキル', '開発案件', '常駐', '商流',
  // スキル（IT）
  'Java', 'Python', 'PHP', 'React', 'Vue', 'Angular', 'TypeScript', 'JavaScript',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Linux',
  'MySQL', 'PostgreSQL', 'Spring', 'Laravel', 'Rails',
  // ファイルリンク（Drive/Sheets = HR確定）
  'docs.google.com', 'drive.google.com', 'sheets.google.com',
  'スキル', '経験年数', '希望単価', '稼働可能',
]

/** スパム/無関係キーワード（検出で -3点） */
const SPAM_NEGATIVE_KEYWORDS = [
  'ニュースレター', 'メルマガ', '配信停止', '自動配信', '自動送信',
  'invoice', 'Invoice', 'receipt', 'Receipt', '領収書', '請求書',
  'noreply', 'no-reply', 'システム通知', 'セキュリティ通知',
  'パスワードリセット', 'メンテナンス', 'アカウント確認',
  'テレアポ代行', '営業代行', '資料請求', 'BtoB', 'timerex',
  '勤怠実績', 'e-staffing', '派遣先管理', 'このメールは自動送信',
  '本メールへの返信はできません', '登録完了のお知らせ', '支払い確認',
]

function scoreText(text: string): number {
  let score = 0
  for (const kw of HR_POSITIVE_KEYWORDS) {
    if (text.includes(kw)) score += 2
  }
  for (const kw of SPAM_NEGATIVE_KEYWORDS) {
    if (text.toLowerCase().includes(kw.toLowerCase())) score -= 3
  }
  return score
}

/** HR/案件メールかどうかを "1"/"0" の1文字で返す Haiku プロンプト（曖昧なケースのみ使用） */
function buildGatePrompt(text: string): string {
  return `あなたはメール振り分け担当です。
次のメールが「人材紹介・案件紹介システムへの取り込み対象」かを判定してください。

【取り込み対象（→ 1）】
・人材: 履歴書・経歴書・スキルシート・職務経歴書・応募・プロフィール紹介など
・案件: 業務委託・開発案件・エンジニア募集・派遣・単価・必須スキル・参画条件など
・本文が短くGoogle Drive / Sheets / Docsのリンクのみでも取り込み対象（→ 1）

【取り込み不要（→ 0）】
・社内雑談・会議招集のみ・ニュースレター・一方向広告
・システム自動通知・エラー通知・挨拶のみ・明らかに無関係な連絡

数字1文字のみ返してください。説明・改行は禁止。

メール内容:
${text}`.trim()
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // API キー認証
  if (ALLOWED_KEY) {
    const provided = event.headers['x-api-key'] ?? ''
    if (provided !== ALLOWED_KEY) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      }
    }
  }

  // リクエストボディのパース
  let text: string
  try {
    const body = JSON.parse(event.body ?? '{}') as { text?: unknown }
    text = typeof body.text === 'string' ? body.text.slice(0, 600) : ''
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  // 本文が空の場合は通過（フェイルオープン）
  if (!text.trim()) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: '1', method: 'rule', note: 'empty text: pass-through' }),
    }
  }

  // ── キーワードスコアリング（Bedrock 不使用） ──────────────────────────
  const score = scoreText(text)

  if (score >= 4) {
    // 明確な HR メール → Bedrock 不使用
    console.log(`[gate-filter] rule=1 score=${score}`)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: '1', method: 'rule', score }),
    }
  }

  if (score <= -3) {
    // 明確なスパム/無関係 → Bedrock 不使用
    console.log(`[gate-filter] rule=0 score=${score}`)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: '0', method: 'rule', score }),
    }
  }

  // ── 曖昧なケースのみ Bedrock で判定 ─────────────────────────────────
  try {
    const raw = await invokeHaiku(buildGatePrompt(text), 5)
    const digit = raw.trim().replace(/[^01]/g, '').slice(0, 1) || '1'
    console.log(`[gate-filter] ai=${digit} score=${score} raw="${raw.slice(0, 20)}"`)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: digit, method: 'ai', score }),
    }
  } catch (err) {
    // Bedrock エラー → フェイルオープン
    console.error('[gate-filter] Bedrock 呼び出しエラー:', err)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: '1', method: 'error', error: String(err) }),
    }
  }
}
