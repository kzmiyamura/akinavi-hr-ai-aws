/**
 * Lambda Function: bedrock-parse（Bedrock JSON構造化抽出）
 *
 * inbound-email の Cerebras/Groq/Gemini が全て失敗した場合の最終フォールバック。
 * Claude Haiku 4.5 でプロンプトを受け取り、JSON を返す。
 *
 * 入力 (POST JSON):
 *   { prompt: string }  ← inbound-email が組み立てた解析プロンプト
 *
 * 出力 (JSON):
 *   { result: string }  ← Haiku の生テキスト出力（JSON文字列）
 *   { error: string }   ← エラー時（result は null）
 *
 * 認証: x-api-key ヘッダー（LAMBDA_API_KEY 環境変数と照合）
 * フェイルオープン: エラー時は error を返すが HTTP 200 を維持
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { invokeHaiku } from '../../shared/bedrockClient'

const ALLOWED_KEY = process.env.LAMBDA_API_KEY ?? ''
// プロンプトの最大文字数（Haiku 4.5 は 200K コンテキスト。コスト抑制のため制限）
const MAX_PROMPT_CHARS = 12_000

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
  let prompt: string
  try {
    const body = JSON.parse(event.body ?? '{}') as { prompt?: unknown }
    prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, MAX_PROMPT_CHARS) : ''
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  if (!prompt.trim()) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'prompt is required' }),
    }
  }

  try {
    // 出力はname/summary/rate等のシンプルなJSON → 512で十分（コスト削減）
    const result = await invokeHaiku(prompt, 512)
    console.log(`[bedrock-parse] 成功 promptLen=${prompt.length} resultLen=${result.length}`)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    }
  } catch (err) {
    console.error('[bedrock-parse] Bedrock 呼び出しエラー:', err)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: null, error: String(err) }),
    }
  }
}
