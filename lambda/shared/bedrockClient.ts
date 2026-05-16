/**
 * Amazon Bedrock Claude 3 Haiku 呼び出し共通モジュール
 * モデル: anthropic.claude-3-haiku-20240307-v1:0
 * リージョン: AWS_REGION 環境変数（既定: us-east-1）
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0'

// Lambda 実行ロールの IAM 権限でアクセスするため明示的なキー設定は不要
const client = new BedrockRuntimeClient({ region: REGION })

/**
 * Claude 3 Haiku を呼び出してテキストを生成する
 * @param prompt   ユーザーへのプロンプト
 * @param maxTokens 最大出力トークン数（既定 10 = 門番フィルター向け）
 * @returns モデルの出力テキスト
 */
export async function invokeHaiku(prompt: string, maxTokens = 10): Promise<string> {
  const requestBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  })

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(requestBody, 'utf-8'),
  })

  const response = await client.send(command)
  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    content?: Array<{ type: string; text: string }>
  }

  return responseBody.content?.[0]?.text ?? ''
}
