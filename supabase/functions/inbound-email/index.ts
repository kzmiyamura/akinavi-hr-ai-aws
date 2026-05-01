// Supabase Edge Function: Make.com (Outlook) → AI解析 → DB保存
// Runtime: Deno / タイムアウト: 最大150秒（Vercel Hobbyの10秒制限を回避）
// POST body (form-urlencoded):
//   type, from, subject, body
//   attachment[data], attachment[mimeType], attachment[name]

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { GoogleGenerativeAI } from 'https://esm.sh/@google/generative-ai@0.24.1'
// mammoth / xlsx: URLを変数化してバンドラーの静的解析を回避（コールドスタート軽量化）
const _MAMMOTH_URL = 'https://esm.sh/' + 'mammoth@1.8.0'
const _XLSX_URL = 'https://esm.sh/' + 'xlsx@0.18.5'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Attachment {
  data: string
  mimeType: string
  name?: string
}

const SUPPORTED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']

const WORD_MIME = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]
const EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]

function getEnv(key: string): string {
  const val = Deno.env.get(key)
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`)
  return val
}

/** Microsoft Graph API の from フィールド（JSON文字列の場合も）からメールアドレスを取り出す */
function parseFrom(from: string): string {
  try {
    const obj = JSON.parse(from)
    return obj?.emailAddress?.address ?? from
  } catch {
    return from
  }
}

const AI_MODEL = 'gemini-2.5-flash-lite'

async function generateJSON(
  prompt: string,
  attachments: Attachment[],
  maxRetries = 2,
): Promise<{ result: unknown; durationMs: number }> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: AI_MODEL, generationConfig: { temperature: 0 } })

  const parts: object[] = []
  for (const att of attachments) {
    if (att.data && SUPPORTED_MIME.includes(att.mimeType)) {
      parts.push({ inlineData: { data: att.data, mimeType: att.mimeType } })
    }
  }
  parts.push({ text: prompt })

  const start = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await model.generateContent(parts)
      const durationMs = Date.now() - start
      const raw = res.response.text()
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const result = JSON.parse(cleaned)

      // スキルと概要が両方空の場合はリトライ
      const isEmpty = Array.isArray((result as any).skills) && (result as any).skills.length === 0
        && !(result as any).summary
      if (isEmpty && attempt < maxRetries) {
        console.warn(`[generateJSON] attempt ${attempt}: skills/summary が空のためリトライ`)
        continue
      }

      return { result, durationMs }
    } catch (e) {
      lastError = e
      if (attempt < maxRetries) {
        console.warn(`[generateJSON] attempt ${attempt}: エラーのためリトライ`, e)
      }
    }
  }
  throw lastError
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** Base64データをUint8Arrayに変換 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Word(.docx)をテキストに変換（バンドル回避の動的インポート） */
async function extractWordText(base64: string): Promise<string> {
  try {
    const { default: mammoth } = await import(_MAMMOTH_URL)
    const buffer = base64ToUint8Array(base64).buffer
    const result = await mammoth.extractRawText({ arrayBuffer: buffer })
    return result.value ?? ''
  } catch (e) {
    console.warn('[Word] テキスト抽出失敗', e)
    return ''
  }
}

/** Excel(.xlsx/.xls)をCSVテキストに変換（バンドル回避の動的インポート・最初の3シートまで） */
async function extractExcelText(base64: string): Promise<string> {
  try {
    const XLSX = await import(_XLSX_URL)
    const bytes = base64ToUint8Array(base64)
    const workbook = XLSX.read(bytes, { type: 'array' })
    const texts: string[] = []
    for (const sheetName of workbook.SheetNames.slice(0, 3)) {
      const sheet = workbook.Sheets[sheetName]
      const csv = XLSX.utils.sheet_to_csv(sheet)
      if (csv.trim()) {
        texts.push(`--- シート: ${sheetName} ---\n${csv}`)
      }
    }
    return texts.join('\n\n')
  } catch (e) {
    console.warn('[Excel] テキスト抽出失敗', e)
    return ''
  }
}

/** 10秒タイムアウト付きfetch */
async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 本文中の Google Drive / Sheets / Docs リンクを検出してコンテンツを取得 */
async function fetchGoogleLinks(body: string): Promise<{
  textContents: { label: string; content: string }[]
  pdfAttachments: Attachment[]
}> {
  const textContents: { label: string; content: string }[] = []
  const pdfAttachments: Attachment[] = []

  // Google Sheets → CSV
  const sheetsMatches = [...body.matchAll(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{25,})[^\s]*/g)]
  for (const match of sheetsMatches) {
    const id = match[1]
    const gidMatch = match[0].match(/[?&]gid=(\d+)/)
    const gid = gidMatch ? gidMatch[1] : null
    const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
    try {
      const res = await fetchWithTimeout(exportUrl)
      if (res.ok) {
        textContents.push({ label: `Googleスプレッドシート(${id})`, content: await res.text() })
        console.log(`[DriveLink] Sheets取得成功: ${id}`)
      } else {
        console.warn(`[DriveLink] Sheetsエクスポート失敗(${res.status}): ${id} - 通常のDrive取得へフォールバックします`)
        const driveRes = await fetchWithTimeout(`https://drive.google.com/uc?export=download&id=${id}`)
        if (driveRes.ok) {
          const text = await driveRes.text()
          textContents.push({ label: `Googleスプレッドシート(DL:${id})`, content: text })
        }
      }
    } catch (e) { console.warn(`[DriveLink] Sheets fetch error: ${id}`, e) }
  }

  // Google Docs → plain text
  const docsMatches = [...body.matchAll(/https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{25,})/g)]
  for (const match of docsMatches) {
    const id = match[1]
    const exportUrl = `https://docs.google.com/document/d/${id}/export?format=txt`
    try {
      const res = await fetchWithTimeout(exportUrl)
      if (res.ok) {
        textContents.push({ label: `Googleドキュメント(${id})`, content: await res.text() })
        console.log(`[DriveLink] Docs取得成功: ${id}`)
      } else {
        console.warn(`[DriveLink] Docs取得失敗(${res.status}): ${id}`)
      }
    } catch (e) { console.warn(`[DriveLink] Docs fetch error: ${id}`, e) }
  }

  // Google Drive ファイル → PDF or テキスト
  const driveMatches = [...body.matchAll(/https:\/\/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{25,})/g)]
  for (const match of driveMatches) {
    const id = match[1]
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${id}`
    try {
      const res = await fetchWithTimeout(downloadUrl)
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('pdf')) {
          const b64 = arrayBufferToBase64(await res.arrayBuffer())
          pdfAttachments.push({ data: b64, mimeType: 'application/pdf', name: `drive_${id}.pdf` })
          console.log(`[DriveLink] Drive PDF取得成功: ${id}`)
        } else if (ct.includes('text') || ct.includes('csv')) {
          textContents.push({ label: `Driveファイル(${id})`, content: await res.text() })
          console.log(`[DriveLink] Drive text取得成功: ${id}`)
        }
      } else {
        console.warn(`[DriveLink] Drive取得失敗(${res.status}): ${id}`)
      }
    } catch (e) { console.warn(`[DriveLink] Drive fetch error: ${id}`, e) }
  }

  return { textContents, pdfAttachments }
}

/** HTMLタグを除去してプレーンテキストに変換 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // form-urlencoded と JSON 両対応
    const contentType = req.headers.get('content-type') ?? ''
    let raw: Record<string, string> = {}

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await req.text()
      const params = new URLSearchParams(text)
      for (const [k, v] of params.entries()) raw[k] = v
    } else {
      raw = await req.json()
    }

    const type: string = raw.type ?? 'candidate'
    const from: string = parseFrom(raw.from ?? '')
    const subject: string = raw.subject ?? ''
    const rawBody: string = raw.body ?? ''
    // HTMLタグが含まれている場合は除去してプレーンテキスト化
    const body: string = rawBody.includes('<html') || rawBody.includes('<div') || rawBody.includes('<p ')
      ? stripHtml(rawBody)
      : rawBody

    // 添付ファイルの解決（attachment[data] 形式 → Attachment オブジェクト）
    let attachments: Attachment[] = []
    if (raw['attachment[data]']) {
      attachments = [{
        data: raw['attachment[data]'],
        mimeType: raw['attachment[mimeType]'] ?? '',
        name: raw['attachment[name]'] ?? undefined,
      }]
    } else if (raw.attachmentsJson) {
      try {
        const parsed = JSON.parse(raw.attachmentsJson)
        if (Array.isArray(parsed)) attachments = parsed
      } catch { /* ignore */ }
    }

    const t0 = Date.now()
    const elapsed = () => `${Date.now() - t0}ms`

    console.log('[STEP1 受信データ]', {
      type, from, subject,
      bodyLength: body.length,
      attachments: attachments.map(a => ({ name: a.name, mimeType: a.mimeType, dataLength: a.data?.length ?? 0 })),
    })

    const supportedAttachments = attachments.filter(a => SUPPORTED_MIME.includes(a.mimeType))
    console.log('[STEP2 添付フィルター]', {
      total: attachments.length,
      supported: supportedAttachments.length,
      filtered: attachments.filter(a => !SUPPORTED_MIME.includes(a.mimeType)).map(a => a.mimeType),
      elapsed: elapsed(),
    })

    // Word/Excelのテキスト抽出
    const officeTextContents: { label: string; content: string }[] = []
    for (const att of attachments) {
      if (WORD_MIME.includes(att.mimeType)) {
        console.log(`[STEP3 Office] Word変換開始: ${att.name} elapsed=${elapsed()}`)
        const text = await extractWordText(att.data)
        if (text.trim()) {
          officeTextContents.push({ label: `Word文書(${att.name ?? 'document'})`, content: text })
          console.log(`[STEP3 Office] Word変換成功: ${text.length}文字 elapsed=${elapsed()}`)
        }
      } else if (EXCEL_MIME.includes(att.mimeType)) {
        console.log(`[STEP3 Office] Excel変換開始: ${att.name} elapsed=${elapsed()}`)
        const text = await extractExcelText(att.data)
        if (text.trim()) {
          officeTextContents.push({ label: `Excelファイル(${att.name ?? 'spreadsheet'})`, content: text })
          console.log(`[STEP3 Office] Excel変換成功: ${text.length}文字 elapsed=${elapsed()}`)
        }
      }
    }
    console.log(`[STEP3 Office完了] elapsed=${elapsed()}`)

    if (!body.trim() && attachments.length === 0) {
      return new Response(JSON.stringify({ error: 'メール本文と添付ファイルが両方空です' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))

    // Google Drive / Sheets / Docs リンクの取得
    console.log(`[STEP4 DriveLink開始] elapsed=${elapsed()}`)
    const { textContents: driveTexts, pdfAttachments: drivePdfs } = await fetchGoogleLinks(body)
    const allAttachments = [...supportedAttachments, ...drivePdfs]
    console.log('[STEP4 DriveLink完了]', {
      texts: driveTexts.map(t => ({ label: t.label, length: t.content.length })),
      pdfs: drivePdfs.map(p => p.name),
      elapsed: elapsed(),
    })

    // Drive取得テキスト + Officeテキストを統合してプロンプトに追記
    const allTextContents = [...driveTexts, ...officeTextContents]
    const driveTextSection = allTextContents.length > 0
      ? '\n\n' + allTextContents.map(t => `--- ${t.label} ---\n${t.content.slice(0, 3000)}`).join('\n\n')
      : ''

    const allAttachmentNames = [
      ...allAttachments.map(a => a.name ?? a.mimeType),
      ...officeTextContents.map(t => t.label),
    ]
    const attachmentNote = allAttachmentNames.length > 0
      ? `\n※添付ファイル（${allAttachmentNames.join('、')}）も含めて解析してください。`
      : ''

    // ── 人材メール ────────────────────────────────────────────
    if (type === 'candidate' || type === 'human') {
      // ファイル名から氏名を推測
      const extractNameFromFilename = (filename: string): string | null => {
        if (!filename) return null
        // 拡張子を除去
        const nameWithoutExt = filename.replace(/\.[^/.]+$/, '')
        // アンダースコアやハイフンで分割し、最後の部分を氏名候補とする
        const parts = nameWithoutExt.split(/[_-]/)
        const lastPart = parts[parts.length - 1]
        // 日本語の姓名パターン（2-4文字の漢字ひらがなカタカナ）にマッチするかチェック
        if (/^[ぁ-んァ-ン一-龯]{2,4}$/.test(lastPart)) {
          return lastPart
        }
        // アルファベット+数字のパターン（例: OH_一之江 → 一之江）
        const match = nameWithoutExt.match(/[a-zA-Z_]+([ぁ-んァ-ン一-龯]{2,4})/)
        if (match) return match[1]
        return null
      }

      const filenameCandidates: string[] = []
      for (const att of allAttachments) {
        if (att.name) {
          const extracted = extractNameFromFilename(att.name)
          if (extracted) filenameCandidates.push(extracted)
        }
      }
      const filenameNote = filenameCandidates.length > 0
        ? `\n※ファイル名から推測される氏名候補: ${filenameCandidates.join('、')}`
        : ''

      const prompt = `
これは営業担当者が転送・送付した人材紹介メールです。${attachmentNote}${filenameNote}
差出人（${from}）は営業担当者であり、候補者本人ではありません。

【重要ルール】
- 本文または添付ファイルに明示的に書かれている情報だけを抽出してください。
- 書かれていない情報は絶対に推測・補完・でっち上げをしないでください。

【氏名の抽出ルール】
- 氏名はPDFや本文の「テキスト内容」から読み取ってください。
- 添付ファイルのファイル名に姓名が明記されている場合（例: 山田太郎.pdf）は、ファイル名から氏名を抽出してください。ただし、拡張子や記号を除去し、人名として妥当な部分のみを使用してください。
- ファイル名から推測される氏名候補が提供される場合がありますが、これはヒントとして参考にしてください。駅名やイニシャルなどが混入している可能性があるため、必ず本文・PDFの内容と照合して判断してください。
- 文字化けしている文字列（例：㻻㻴、㼃indows、㻼㻴㻼 等）は正しく読み取れていません。これらを氏名として使わないでください。
- PDFは複数ページある場合があります。必ず全ページを確認してください。
- 学歴/職歴ページ（最終ページ付近）に「フリガナ」「氏名」が明記されている場合、そのページの情報を最優先で使用してください。
- イニシャル（例: O.H., T.Y.）が明記されている場合は、それを氏名として使用してください。フルネームが同じ文書内で見つからない場合でもイニシャルを有効とします。
- 地名・駅名・会社名を氏名と混同しないでください。
- 氏名が本文・添付テキスト・ファイル名に一切見つからない場合のみ "不明" にしてください。

【メールアドレスの抽出ルール】
- emailは候補者本人のアドレスのみです。
- 差出人（${from}）は営業担当者のため、このアドレスは絶対に入れないでください。
- PDFや本文に候補者のメールアドレスが書かれていなければ必ず null にしてください。

【その他のルール】
- 電話番号も明記されているものだけ。なければ null。
- skillsはIT系に限らず、職種問わず本文・添付に明記されたスキル・ツール・知見を全て抽出してください。
  例: ITエンジニア系（PHP, Java, MySQL等）はもちろん、
  デザイン系（Illustrator, Photoshop, Figma, After Effects等）、
  ビジネス系（Excel, PowerPoint, Salesforce等）、
  知見・専門性（グラフィックデザイン, WEBデザイン, 動画編集, ECサイト運営等）も含めてください。
- 本文中で「/」「・」「,」「、」で区切られたスキルは必ず個別に分割して抽出してください。
  例:「Illustrator / Photoshop / Figma」→ ["Illustrator", "Photoshop", "Figma"]
  例:「グラフィックデザイン / WEBデザイン / 動画編集」→ ["グラフィックデザイン", "WEBデザイン", "動画編集"]
- skillsは重複なしで返してください。表記が異なっても同じ技術は1つにまとめ、より一般的な表記に統一してください。
- experienceYearsは職歴の最初の年から現在までの年数を計算してください。
  備考欄や本文に「デザイン歴20年」「経験年数○年」等の明記があればその値を優先してください。
- summaryは具体的な社名・プロジェクト名・実績・受賞歴を必ず含めてください。

件名: ${subject}

【スキル正規化ルール】
※このリストは「表記ゆれを統一するための参考」です。リストにあるスキルを新たに追加してはいけません。
本文・添付に明記されているスキルのみ抽出し、以下の表記に統一してください：
- Javascript / JS → JavaScript
- Mysql / MYSQL → MySQL
- PostageSQL / Postgre → PostgreSQL
- Salesforce / saleforce → Salesforce
- Powerpoint → PowerPoint
- After effect / AfterEffects → After Effects
- Premiere / PremierePro → Premiere Pro

【地域・勤務地に関するルール】
- nearestStation: 「基本情報」や「最寄駅」フィールドから記載された駅名を抽出。都道府県名も含めます。例: "北海道 麻生駅"。記載がなければ null。
- prefecture: nearestStation から都道府県を抽出。例: "北海道"、"東京都"。記載がなければ null。
- availableRegions: 就業可能な地域（都道府県単位）。居住地（prefecture）がある場合は必ず含めてください。例: ["北海道", "東京都"]。
- currentWorkLocation: 現在の拠点。prefecture または nearestStation が判明している場合は、その都道府県を必ず設定してください。例: "北海道"。
- remoteAvailable: 本文やサマリーに「リモート希望」「リモート勤務」「フリーランス」等の記載があれば true。明記がなければ false。

抽出項目（JSON形式のみで返してください。前後に余分なテキスト不要）:
- name: string（フルネーム。ファイル名・文字化け文字列は使わない。不明なら "不明"）
- email: string | null（候補者本人のみ。なければ null）
- phone: string | null（明記されたもののみ。なければ null）
- skills: string[]（職種問わず明記されているもののみ。重複なし。正規化済み。なければ[]）
- skillsByCategory: object（skillsを以下の14カテゴリに分類。該当なしは[]）
  【カテゴリ厳守ルール】以下の14カテゴリキーのみ使用すること。それ以外のキーは絶対に追加しないこと。どのカテゴリにも当てはまらないスキルはすべて others に入れること。
  - languages: string[]（プログラミング言語・クエリ言語。例: PHP, Java, Python, SQL, HTML/CSS）
  - frameworks: string[]（Webフレームワーク・アプリFW等。例: Laravel, React, Vue, Spring）
  - libraries: string[]（ライブラリ、UIキット等。例: jQuery, Bootstrap, NumPy）
  - os: string[]（OS。例: Linux, Windows, MacOS, Unix）
  - databases: string[]（RDB, NoSQL, KVS等。例: MySQL, PostgreSQL, MongoDB, Redis）
  - dwh: string[]（データウェアハウス・分析基盤。例: BigQuery, Snowflake, Redshift, dbt, Looker, Tableau, Power BI）
  - clouds: string[]（クラウドサービス。例: AWS, Azure, GCP, Firebase）
  - infrastructures: string[]（インフラ技術。例: Docker, Kubernetes, Terraform, Nginx, Apache, CI/CD）
  - tools: string[]（開発・業務ツール。例: Git, Jira, Slack, Notion, Salesforce, Excel, PowerPoint）
  - methodologies: string[]（手法・マネジメント。例: アジャイル, スクラム, 要件定義, 企画立案, ディレクション, PM）
  - certifications: string[]（資格試験等。例: AWS認定, 情報処理技術者, TOEIC）
  - design: string[]（デザイン・クリエイティブ。例: Illustrator, Photoshop, Figma, XD, After Effects, Premiere Pro, グラフィックデザイン, 動画編集）
  - marketing: string[]（マーケティング・集客。例: SEO, SNS運用, Web広告, ECサイト運営, デジタルマーケティング）
  - others: string[]（上記14カテゴリに当てはまらないもの全て）
- roles: string[]（担当役割・職種。例: ["PM", "グラフィックデザイナー", "クリエイティブディレクター", "ITコンサル"]。明記されているもののみ）
- industries: string[]（業界経験。例: ["通信", "金融", "広告", "EC"]。職歴・本文から読み取れるもの）
- experienceYears: number | null（計算または明記された値。なければ null）
- summary: string（職務経歴の概要300字以内。社名・実績・受賞歴を含めること）
- nearestStation: string | null（最寄駅。都道府県を含む形式。例: "北海道 麻生駅"。記載がなければ null）
- prefecture: string | null（都道府県。例: "北海道"。記載がなければ null）
- availableRegions: string[] | null（就業可能な地域。例: ["北海道", "東京都"]。情報がなければ null）
- currentWorkLocation: string | null（現在の拠点都道府県。例: "北海道"。情報がなければ null）
- remoteAvailable: boolean（リモート勤務対応可否。「リモート希望」等の明記で true。記載なければ false）

本文:
${body.slice(0, 3000)}${driveTextSection}

JSON:`.trim()

      console.log(`[STEP5 AI呼び出し開始] elapsed=${elapsed()}`)
      const { result, durationMs } = await generateJSON(prompt, allAttachments)
      console.log(`[STEP5 AI呼び出し完了] durationMs=${durationMs} elapsed=${elapsed()}`)
      const analyzed = result as {
        name: string; email: string | null; phone: string | null
        skills: string[]
        skillsByCategory: {
          languages: string[]; frameworks: string[]; libraries: string[]; os: string[]
          databases: string[]; dwh: string[]; clouds: string[]; infrastructures: string[]
          tools: string[]; methodologies: string[]; certifications: string[]
          design: string[]; marketing: string[]; others: string[]
        }
        roles: string[]
        industries: string[]
        experienceYears: number | null; summary: string
        nearestStation: string | null
        prefecture: string | null
        availableRegions: string[] | null
        currentWorkLocation: string | null
        remoteAvailable: boolean
      }

      console.log(`[STEP6 AI解析結果 candidate] elapsed=${elapsed()}`, JSON.stringify(analyzed, null, 2))

      // スキル重複除去（trim + 大文字小文字を無視して正規化）
      const skills = Array.from(
        new Map(
          (analyzed.skills ?? [])
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0)
            .map((s: string) => [s.toLowerCase(), s])
        ).values()
      )

      // 送信者メールアドレスが混入していたら除去
      const senderEmails = from.split(/[,;]/).map((s: string) => s.trim().toLowerCase())
      const email = analyzed.email && !senderEmails.includes(analyzed.email.toLowerCase())
        ? analyzed.email
        : null

      const dbPayload = {
        name: analyzed.name ?? '不明',
        email,
        phone: analyzed.phone ?? null,
        skills,
        experience_years: analyzed.experienceYears ?? null,
        raw_profile: {
          text: body.slice(0, 5000),
          summary: analyzed.summary ?? '',
          skillsByCategory: analyzed.skillsByCategory ?? {
            languages: [], frameworks: [], libraries: [], os: [],
            databases: [], dwh: [], clouds: [], infrastructures: [],
            tools: [], methodologies: [], certifications: [],
            design: [], marketing: [], others: [],
          },
          roles: analyzed.roles ?? [],
          industries: analyzed.industries ?? [],
          nearestStation: analyzed.nearestStation ?? null,
          prefecture: analyzed.prefecture ?? null,
          availableRegions: analyzed.availableRegions ?? null,
          currentWorkLocation: analyzed.currentWorkLocation ?? null,
          remoteAvailable: analyzed.remoteAvailable ?? false,
          from, subject,
          attachmentCount: allAttachments.length,
          attachmentNames: [
            ...allAttachments.map(a => a.name ?? a.mimeType),
            ...officeTextContents.map(t => t.label),
          ],
          driveLinks: driveTexts.map(t => t.label),
          aiAnalysis: analyzed,
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
      }

      console.log(`[STEP7 DB保存開始] elapsed=${elapsed()}`)
      const { data, error } = email
        ? await supabase.from('candidates').upsert(dbPayload, { onConflict: 'email' }).select().single()
        : await supabase.from('candidates').insert(dbPayload).select().single()

      if (error) throw new Error(`候補者保存エラー: ${error.message}`)
      console.log(`[STEP7 DB保存完了] elapsed=${elapsed()}`)

      // candidate_skills に一括INSERT
      const validCategories = [
        'languages', 'frameworks', 'libraries', 'os',
        'databases', 'dwh', 'clouds', 'infrastructures',
        'tools', 'methodologies', 'certifications',
        'design', 'marketing', 'others',
      ]
      const skillsPayload: { candidate_id: string; category: string; skill: string }[] = []
      const categoryMap = analyzed.skillsByCategory ?? {}
      for (const category of validCategories) {
        const skillList: string[] = (categoryMap as Record<string, string[]>)[category] ?? []
        for (const skill of skillList) {
          if (skill && skill.trim()) skillsPayload.push({ candidate_id: data.id, category, skill: skill.trim() })
        }
      }
      if (skillsPayload.length > 0) {
        await supabase.from('candidate_skills').delete().eq('candidate_id', data.id)
        const { error: skillsError } = await supabase.from('candidate_skills').insert(skillsPayload)
        if (skillsError) console.error('[candidate_skills INSERT error]', skillsError)
        else console.log(`[inbound] スキル登録完了: ${skillsPayload.length}件`)
      }

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'candidate',
        model: AI_MODEL,
        from_address: from,
        subject,
        ai_result: analyzed,
        prompt_length: prompt.length,
        status: 'success',
        duration_ms: durationMs,
        linked_id: data.id,
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      console.log(`[inbound] 人材登録完了: ${data.name}`)
      return new Response(JSON.stringify({ ok: true, type: 'candidate', id: data.id, name: data.name }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── 案件メール ────────────────────────────────────────────
    if (type === 'project') {
      const prompt = `
以下のメール本文から案件情報を抽出し、JSON形式のみで返してください。${attachmentNote}

【重要ルール】書かれていない情報は推測せず null または空にしてください。

差出人: ${from}
件名: ${subject}

抽出項目（JSON形式のみで返してください。前後に余分なテキスト不要）:
- title: string（案件名。不明なら "案件"）
- client: string | null（クライアント名。不明なら null）
- description: string（案件概要）
- requiredSkills: string[]（必須スキル。なければ[]）
- budgetMin: number | null（月額・万円。不明ならnull）
- budgetMax: number | null（月額・万円。不明ならnull）

本文:
${body.slice(0, 3000)}

JSON:`.trim()

      const { result, durationMs } = await generateJSON(prompt, attachments)
      const analyzed = result as {
        title: string; client: string | null; description: string
        requiredSkills: string[]; budgetMin: number | null; budgetMax: number | null
      }

      console.log('[AI解析結果 project]', JSON.stringify(analyzed, null, 2))

      const { data, error } = await supabase.from('projects').insert({
        title: analyzed.title ?? '案件',
        client: analyzed.client ?? null,
        description: analyzed.description ?? '',
        required_skills: analyzed.requiredSkills ?? [],
        budget_min: analyzed.budgetMin ?? null,
        budget_max: analyzed.budgetMax ?? null,
        raw_data: {
          text: body.slice(0, 5000),
          from, subject,
          attachmentCount: attachments.length,
          attachmentNames: attachments.map(a => a.name ?? a.mimeType),
          aiAnalysis: analyzed,
        },
        created_by: 'make-inbound',
      }).select().single()

      if (error) throw new Error(`案件保存エラー: ${error.message}`)

      const { error: logError } = await supabase.from('ai_logs').insert({
        type: 'project',
        model: AI_MODEL,
        from_address: from,
        subject,
        ai_result: analyzed,
        prompt_length: prompt.length,
        status: 'success',
        duration_ms: durationMs,
        linked_id: data.id,
      })
      if (logError) console.error('[ai_logs INSERT error]', logError)

      console.log(`[inbound] 案件登録完了: ${data.title}`)
      return new Response(JSON.stringify({ ok: true, type: 'project', id: data.id, title: data.title }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: `不明な type: ${type}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[inbound-email] エラー:', message)

    try {
      const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'))
      await supabase.from('ai_logs').insert({
        type: 'unknown',
        model: AI_MODEL,
        ai_result: {},
        status: 'error',
        error_message: message,
      })
    } catch { /* ログ保存失敗は握りつぶす */ }

    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})