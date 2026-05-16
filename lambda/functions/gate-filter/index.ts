/**
 * Lambda Function: gate-filter（門番フィルター）
 *
 * メールの先頭 ~500 文字を受け取り、HR/案件マッチングに関係するかを
 * Bedrock Claude 3 Haiku で超高速・超低コスト判定する。
 *
 * 入力 (POST JSON):
 *   { text: string }  ← 件名・差出人・本文先頭 500 文字
 *
 * 出力 (JSON):
 *   { result: "1" }  ← 関係あり（取り込み続行）
 *   { result: "0" }  ← 関係なし（以降の処理をスキップ）
 *
 * 認証: x-api-key ヘッダー（LAMBDA_API_KEY 環境変数と照合）
 * フェイルオープン: エラー時は "1" を返し、処理を続行させる
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { invokeHaiku } from '../../shared/bedrockClient'

const ALLOWED_KEY = process.env.LAMBDA_API_KEY ?? ''

/** HR/案件メールかどうかを "1"/"0" の1文字で返す Haiku プロンプト */
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
      body: JSON.stringify({ result: '1', note: 'empty text: pass-through' }),
    }
  }

  try {
    const raw = await invokeHaiku(buildGatePrompt(text), 5)
    // 返答から 0 か 1 だけ抽出（余計な文字が混入しても安全に処理）
    const digit = raw.trim().replace(/[^01]/g, '').slice(0, 1) || '1'
    console.log(`[gate-filter] result=${digit} rawResponse="${raw.slice(0, 20)}"`)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: digit }),
    }
  } catch (err) {
    // Bedrock エラー → フェイルオープン（処理を止めない）
    console.error('[gate-filter] Bedrock 呼び出しエラー:', err)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: '1', error: String(err) }),
    }
  }
}
