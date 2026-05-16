/**
 * Lambda Function: pdf-processor（PDF処理 + Haiku要約）
 *
 * 2つのユースケースを処理する:
 *   A) テキスト抽出済み PDF → そのテキストを Haiku で構造化要約
 *   B) スキャン/未解析 PDF → pdfjs-dist（Node.js）→ Textract → Haiku 要約
 *
 * 入力 (POST JSON):
 *   { extractedText?: string }   ← Deno の pdfjs-dist でテキスト抽出済み（ケースA）
 *   { pdfBase64?: string }       ← バイナリPDF base64（ケースB: スキャンPDF等）
 *
 * 出力 (JSON):
 *   {
 *     summary: string | null,    ← 採用担当者向け整形テキスト（Haiku要約）
 *     rawText: string | null,    ← 抽出生テキスト（Haiku失敗時のフォールバック用）
 *     error?: string
 *   }
 *
 * 処理フロー（ケースB）:
 *   pdfjs-dist（Node.js）→ 失敗 → Amazon Textract → 成功 → Haiku要約
 *
 * 認証: x-api-key ヘッダー（LAMBDA_API_KEY 環境変数と照合）
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import {
  TextractClient,
  DetectDocumentTextCommand,
} from '@aws-sdk/client-textract'
import { invokeHaiku } from '../../shared/bedrockClient'

const REGION = process.env.AWS_REGION ?? 'us-east-1'
const ALLOWED_KEY = process.env.LAMBDA_API_KEY ?? ''

// Textract: Lambda の IAM 実行ロール権限で認証
const textract = new TextractClient({ region: REGION })

// Textract の同期 API バイトサイズ上限: 5MB
const TEXTRACT_MAX_BYTES = 5 * 1024 * 1024

// 要約の対象テキスト最大文字数
const TEXT_LIMIT = 8000

// ── Haiku プロンプト ──────────────────────────────────────────────────────

function buildSummaryPrompt(text: string): string {
  return `
あなたは人材採用の書類審査担当者です。
以下の職務経歴書・スキルシートから、採用担当者が即座に判断できる情報を抽出してください。

【出力ルール】
- 以下の形式のプレーンテキストで出力してください（JSON禁止）
- 書かれていない項目は「記載なし」と書いてください
- 推測・補完は絶対にしないでください
- 簡潔に、1〜2行でまとめてください

【出力形式】
主要スキル: <スキル名をカンマ区切り>
経験年数: <例: 7年>
直近業務: <直近プロジェクト・役割・期間を2〜3文で>
稼働可能時期: <例: 即日、2025年8月以降>
希望単価: <例: 80万円/月、記載なし>
勤務形態: <例: リモート希望、常駐可、記載なし>

---
${text.slice(0, TEXT_LIMIT)}
`.trim()
}

// ── PDF テキスト抽出: pdfjs-dist（Node.js） ───────────────────────────────

async function extractWithPdfjs(pdfBytes: Uint8Array): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js') as {
      GlobalWorkerOptions: { workerSrc: string }
      getDocument: (params: object) => { promise: Promise<{
        numPages: number
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
        }>
      }> }
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = ''

    const doc = await pdfjsLib.getDocument({
      data: pdfBytes,
      useWorkerFetch: false,
      isEvalSupported: false,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    }).promise

    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(content.items.map(item => item.str ?? '').join(''))
    }

    const text = pages.join('\n').trim()
    if (text.length > 50) return text

    console.warn(`[pdfjs] テキスト不足 (${text.length}文字) - スキャンPDFの可能性`)
    return null
  } catch (err) {
    console.warn('[pdfjs] テキスト抽出失敗:', String(err))
    return null
  }
}

// ── PDF テキスト抽出: Amazon Textract ─────────────────────────────────────

async function extractWithTextract(pdfBytes: Uint8Array): Promise<string | null> {
  if (pdfBytes.length > TEXTRACT_MAX_BYTES) {
    console.warn(`[Textract] サイズ超過 (${pdfBytes.length}B > ${TEXTRACT_MAX_BYTES}B)、スキップ`)
    return null
  }

  try {
    const response = await textract.send(
      new DetectDocumentTextCommand({
        Document: { Bytes: pdfBytes },
      }),
    )

    const lines = (response.Blocks ?? [])
      .filter(b => b.BlockType === 'LINE' && b.Text)
      .map(b => b.Text!)

    const text = lines.join('\n').trim()
    if (text.length > 50) return text

    console.warn(`[Textract] テキスト不足 (${text.length}文字)`)
    return null
  } catch (err) {
    console.error('[Textract] 呼び出し失敗:', String(err))
    return null
  }
}

// ── Lambda ハンドラー ──────────────────────────────────────────────────────

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
  let reqBody: { extractedText?: unknown; pdfBase64?: unknown }
  try {
    reqBody = JSON.parse(event.body ?? '{}') as typeof reqBody
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  let rawText: string | null = null

  // ── ケースA: テキスト抽出済み ────────────────────────────────────────
  if (typeof reqBody.extractedText === 'string' && reqBody.extractedText.trim().length > 50) {
    rawText = reqBody.extractedText
    console.log(`[pdf-processor] ケースA: 抽出済みテキスト受信 (${rawText.length}文字)`)
  }
  // ── ケースB: バイナリ PDF → pdfjs → Textract ─────────────────────────
  else if (typeof reqBody.pdfBase64 === 'string' && reqBody.pdfBase64.length > 0) {
    console.log(`[pdf-processor] ケースB: PDF base64 受信 (${reqBody.pdfBase64.length}文字)`)

    let pdfBytes: Uint8Array
    try {
      pdfBytes = Buffer.from(reqBody.pdfBase64, 'base64')
    } catch (err) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `base64 デコード失敗: ${String(err)}` }),
      }
    }

    // ① pdfjs-dist（Node.js）でテキスト抽出
    rawText = await extractWithPdfjs(pdfBytes)

    // ② 失敗時 → Amazon Textract（スキャンPDF・画像PDF対応）
    if (!rawText) {
      console.log('[pdf-processor] pdfjs失敗 → Textract にフォールバック')
      rawText = await extractWithTextract(pdfBytes)
    }
  }

  // テキストが取得できなかった場合
  if (!rawText) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: null,
        rawText: null,
        error: 'テキスト抽出失敗（pdfjs・Textractいずれも取得不能）',
      }),
    }
  }

  // ── Bedrock Claude 3 Haiku で構造化要約 ──────────────────────────────
  try {
    const haikuOutput = await invokeHaiku(buildSummaryPrompt(rawText), 512)
    const summary = haikuOutput.trim()

    console.log(`[pdf-processor] Haiku要約成功 (${summary.length}文字)`)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        rawText: rawText.slice(0, 3000),  // デバッグ用（inbound-email では summary を優先）
      }),
    }
  } catch (err) {
    // Haiku 失敗 → raw テキストをそのまま返す（呼び出し元は rawText を使う）
    console.error('[pdf-processor] Haiku要約失敗、rawText を返却:', String(err))
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: null,
        rawText: rawText.slice(0, 6000),
        error: String(err),
      }),
    }
  }
}
