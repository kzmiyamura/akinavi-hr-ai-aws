/**
 * 受信メール Webhook の正規化（純関数・Vitest で検証可能）
 *
 * ## これは何のためにあるか
 *
 * オンプレ版では顧客ごとに受信経路が違う（Microsoft Graph が使えない顧客がいる）。
 * そこで「顧客のメールボックスから転送 → 受信メールサービスが Webhook で POST」
 * という経路を用意する。ここはその POST を **inbound-email がすでに理解できる形**
 * に均すだけの層で、解析ロジックは一切持たない。
 *
 *   顧客のメールボックス ──転送──> 受信メールサービス ──POST──> inbound-mail-webhook
 *                                                                      │ 正規化
 *                                                                      ▼
 *                                                                inbound-email（既存・無改造）
 *
 * ## ⚠ 転送メールは本文が消える（2026-10-03 に実装を読んで判明）
 *
 * inbound-email の `STRONG_QUOTE_DELIMITERS` は区切り線を見つけると
 * **`body.slice(0, m)`** を採る。つまり区切り線より「前」を残す。
 * これは**返信**の引用（新しい本文が上にある）には正しいが、**転送**では逆で、
 * 欲しい中身は転送ヘッダより「下」にある。
 *
 *   （転送者の署名や「ご確認ください」）   ← これだけが残る
 *   ---------- 転送メッセージ ----------
 *   差出人: 山田 <y@agency.co.jp>
 *   件名: 【人材】Java 10年
 *   （本当に欲しい人材情報）               ← 丸ごと捨てられる
 *
 * 前置きが空なら（区切り線が位置0なので `m > 0` が false）切られずに通るが、
 * Outlook のように署名を上に付ける設定だと**静かに中身が消える**。
 * そのため転送ヘッダの展開はこの層で済ませ、inbound-email には
 * 「転送でない普通のメール」に見える形だけを渡す。
 *
 * ## ⚠ 差出人を間違えると静かに全部消える
 *
 * inbound-email は `from` のドメインが `app_config.own_email_domain` と一致すると
 * OWN_DOMAIN としてスキップする。顧客が自分のメールボックスから転送すると
 * `from` は顧客自身になりうるので、**復元に失敗したまま渡すと全件スキップされる**。
 * 無言の取りこぼしは過去に何度もやっているので（8/17 のトークン上書きで丸1日
 * 「未読0件」を返し続けた等）、ここでは**復元できなかったことを明示的に返す**。
 * 判断は呼び出し側（index.ts）が行う。
 */

/** 対応する受信メールサービス。`generic` は Make / Pipedream / 自前スクリプト等 */
export type Provider = 'sendgrid' | 'mailgun' | 'postmark' | 'cloudmailin' | 'generic'

export interface NormAttachment {
  data: string
  mimeType: string
  name?: string
}

export interface NormalizedMail {
  /** 原メールの差出人アドレス（転送なら復元後のもの） */
  from: string
  /** 転送ヘッダを剥がす前の差出人（＝転送者）。転送でなければ from と同じ */
  envelopeFrom: string
  subject: string
  body: string
  /** メールサービスが伝えてきた受信日時（ISO）。無ければ null */
  emailReceivedAt: string | null
  attachments: NormAttachment[]
  /** 本文から転送ヘッダを検出して剥がしたか */
  forwarded: boolean
  provider: Provider
  /** 何をどう決めたかの診断メモ。ログに1行出して後から追えるようにする */
  notes: string[]
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 差出人                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * メールアドレスの抽出パターン。
 * inbound-email 側の `extractEmailFromFrom` と同じ形にそろえてある。
 */
const ADDR_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/

/**
 * `差出人` フィールドから素のメールアドレスだけを取り出す。
 *
 * 受け取る形がサービスごとに違う:
 *   - Microsoft Graph … `{"emailAddress":{"address":"a@b.co.jp","name":"山田"}}`
 *   - RFC822          … `山田 太郎 <a@b.co.jp>` / `"Yamada, T." <a@b.co.jp>`
 *   - 素のアドレス     … `a@b.co.jp`
 *   - Postmark        … `{"Email":"a@b.co.jp","Name":"山田"}`
 *
 * ⚠ inbound-email の `parseFrom` は Graph の JSON しか剥がさないので、
 *    `山田 <a@b.co.jp>` を渡すと `from.split('@')[1]` が `b.co.jp>` になり
 *    （末尾に `>` が付く）agent_companies の突き合わせが静かに外れる。
 *    ここで必ず素のアドレスにしてから渡す。
 */
export function extractAddress(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    return extractAddress(JSON.stringify(value))
  }
  const s = String(value).trim()
  if (!s) return ''
  // JSON（Graph / Postmark の FromFull）なら中のアドレスを拾う
  if (s.startsWith('{') || s.startsWith('[')) {
    const m = s.match(ADDR_RE)
    return m ? m[0].toLowerCase() : ''
  }
  const m = s.match(ADDR_RE)
  return m ? m[0].toLowerCase() : ''
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 転送ヘッダの展開                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * 転送ヘッダのキー。日本語クライアントと英語クライアントの両方。
 * 値は正規化後の意味。
 *
 * ⚠ ここに無いキーが1行挟まるとヘッダブロックが途切れたと判定される。
 *    新しいクライアントで取りこぼしたらまずここを増やす。
 */
const HEADER_KEYS: Array<{ re: RegExp; field: 'from' | 'subject' | 'date' | 'other' }> = [
  { re: /^(?:差出人|送信者|発信者|From)$/i, field: 'from' },
  { re: /^(?:件名|題名|Subject)$/i, field: 'subject' },
  { re: /^(?:送信日時|日時|日付|Date|Sent)$/i, field: 'date' },
  { re: /^(?:宛先|送信先|To|Cc|CC|Bcc|BCC|Reply-To|返信先)$/i, field: 'other' },
]

/** 「---------- 転送メッセージ ----------」等の区切り線 */
const FORWARD_MARKER_RE =
  /^[ \t]*[-_─━=＝*]{3,}[ 　]*(?:転送(?:メッセージ)?|Forwarded message|Original Message|元のメッセージ)[^\n]*$/im

/** Outlook が本文の上に入れる区切り線だけの行（キー行がこの直後に来る） */
const BARE_RULE_RE = /^[ \t]*[-_─━=＝]{10,}[ \t]*$/m

interface ForwardUnwrap {
  forwarded: boolean
  body: string
  from: string
  subject: string
  date: string
}

/**
 * 1行を `キー: 値` に分解する。全角コロンと全角スペースを許す。
 * 日本語の本文（「差出人：」以外の普通の文）を誤ってヘッダと見なさないよう、
 * キーは HEADER_KEYS に完全一致するものだけを認める。
 */
function parseHeaderLine(line: string): { field: 'from' | 'subject' | 'date' | 'other'; value: string } | null {
  const m = line.match(/^[ \t>]*([^:：\n]{1,16})[:：][ \t　]*(.*)$/)
  if (!m) return null
  const key = m[1].trim()
  for (const h of HEADER_KEYS) {
    if (h.re.test(key)) return { field: h.field, value: m[2].trim() }
  }
  return null
}

/**
 * 手で転送されたメールから、原メールの差出人・件名・本文を取り出す。
 *
 * 判定は「既知のヘッダキーが2行以上連続するブロック」を本文の先頭寄りで探す方式。
 * 区切り線（`---------- 転送メッセージ ----------`）があればそこを起点にし、
 * 無くても（Outlook の「差出人: …」だけが続く形）拾えるようにしてある。
 *
 * **外側のブロックを採る。** 入れ子（代理店がさらに転送していた）の場合、
 * 欲しいのは「顧客にメールを送ってきた会社」＝一番外側の差出人なので、
 * 最初に見つかったブロックで確定して良い。
 *
 * 転送でなければ `forwarded: false` と元の body をそのまま返す（無害）。
 */
export function unwrapForwarded(input: string): ForwardUnwrap {
  const none: ForwardUnwrap = { forwarded: false, body: input, from: '', subject: '', date: '' }
  if (!input || !input.trim()) return none

  // 行単位で扱う。CRLF / CR / LF が混在しても同じ結果になるよう先に LF へ寄せる。
  const text = input.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  // ヘッダブロックの開始行を探す。区切り線があればその直後から、
  // 無ければ先頭から 40 行以内（転送者の署名ぶんの余裕）を走査する。
  let scanFrom = 0
  const markerIdx = lines.findIndex(l => FORWARD_MARKER_RE.test(l))
  if (markerIdx >= 0) {
    scanFrom = markerIdx + 1
  } else {
    const ruleIdx = lines.findIndex(l => BARE_RULE_RE.test(l))
    if (ruleIdx >= 0) scanFrom = ruleIdx + 1
  }
  const scanLimit = Math.min(lines.length, scanFrom + 40)

  for (let i = scanFrom; i < scanLimit; i++) {
    const first = parseHeaderLine(lines[i])
    if (!first) continue

    // ここから連続するヘッダ行を集める。空行は1つまで許容しない
    // （Outlook は空行を挟まないし、許すと本文を食い込む）。
    const found: Record<string, string> = {}
    let end = i
    let count = 0
    for (let j = i; j < lines.length; j++) {
      const h = parseHeaderLine(lines[j])
      if (!h) break
      if (h.field !== 'other' && !found[h.field]) found[h.field] = h.value
      count++
      end = j
    }

    // キー行が1行だけなら転送ヘッダとは断定しない（本文中の「件名: xxx」等の誤検出を防ぐ）。
    // 人材メールは本文に「氏名:」「単価:」が並ぶので、ここを緩めると本文を切ってしまう。
    if (count < 2) continue
    // 差出人が取れないブロックは転送ヘッダとして役に立たない
    const from = extractAddress(found.from ?? '')
    if (!from) continue

    const body = lines.slice(end + 1).join('\n').trim()
    return {
      forwarded: true,
      body: body || input,
      from,
      subject: (found.subject ?? '').trim(),
      date: (found.date ?? '').trim(),
    }
  }

  return none
}

/* ────────────────────────────────────────────────────────────────────────── */
/* サービス判別とフィールド対応                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * どの受信メールサービスから来た POST かを、特徴的なキーの有無で判別する。
 * 判別は本文の取り出し方を決めるためだけに使う。外した場合も `generic` が
 * 一般的な別名を順に試すので致命的にはならない。
 */
export function detectProvider(raw: Record<string, unknown>): Provider {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k)
  // SendGrid Inbound Parse: envelope と charsets を必ず付ける
  if (has('envelope') && (has('charsets') || has('SPF'))) return 'sendgrid'
  // Mailgun Routes: body-plain / stripped-text
  if (has('body-plain') || has('stripped-text')) return 'mailgun'
  // Postmark Inbound: 先頭大文字のキー
  if (has('TextBody') || has('FromFull')) return 'postmark'
  // CloudMailin: plain / headers を持つ JSON
  if (has('plain') && has('headers')) return 'cloudmailin'
  return 'generic'
}

/** 最初に中身のある値を返す */
function pick(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k]
    if (v == null) continue
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    if (s.trim()) return s
  }
  return ''
}

/** サービスごとの「本文（プレーン）」「本文（HTML）」「件名」「差出人」のキー順 */
const FIELD_MAP: Record<Provider, { from: string[]; subject: string[]; text: string[]; html: string[] }> = {
  sendgrid: { from: ['from'], subject: ['subject'], text: ['text'], html: ['html'] },
  // stripped-text は Mailgun が署名・引用を削ったもの。転送ヘッダも削られて
  // 差出人を復元できなくなるため、**body-plain（生）を先に見る**。
  mailgun: {
    from: ['sender', 'from'],
    subject: ['subject', 'Subject'],
    text: ['body-plain', 'stripped-text'],
    html: ['body-html', 'stripped-html'],
  },
  postmark: {
    from: ['FromFull', 'From'],
    subject: ['Subject'],
    text: ['TextBody'],
    html: ['HtmlBody'],
  },
  cloudmailin: { from: ['from'], subject: ['subject'], text: ['plain'], html: ['html'] },
  generic: {
    from: ['from', 'From', 'sender', 'fromAddress'],
    subject: ['subject', 'Subject', 'title'],
    text: ['body', 'text', 'plainText', 'bodyText', 'plain', 'message', 'content'],
    html: ['html', 'bodyHtml', 'htmlBody'],
  },
}

/** メールサービスが伝えてくる受信日時のキー */
const RECEIVED_AT_KEYS = ['email_received_at', 'Date', 'date', 'timestamp', 'received_at', 'Timestamp']

/* ────────────────────────────────────────────────────────────────────────── */
/* 添付                                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * サービスごとの添付配列を `{data, mimeType, name}` に均す。
 *
 * inbound-email は `attachmentsJson`（この形の JSON 配列）を受けられるので、
 * **複数添付をそのまま渡せる**。`attachment[data]` 形式は先頭1件しか見ない作りなので使わない。
 */
export function normalizeAttachments(value: unknown): NormAttachment[] {
  const arr: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim().startsWith('[')
      ? (() => { try { return JSON.parse(value) as unknown[] } catch { return [] } })()
      : []
  const out: NormAttachment[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    // data / content / Content / content_base64 / contentBytes を順に見る
    const dataRaw = o.data ?? o.content ?? o.Content ?? o.content_base64 ?? o.contentBytes
    if (typeof dataRaw !== 'string' || !dataRaw.trim()) continue
    const mimeRaw = o.mimeType ?? o.content_type ?? o.ContentType ?? o.contentType ?? o.type
    const nameRaw = o.name ?? o.Name ?? o.file_name ?? o.fileName ?? o.filename
    out.push({
      // data: URL 形式（`data:application/pdf;base64,xxxx`）で来ることがある
      data: String(dataRaw).replace(/^data:[^;]*;base64,/, ''),
      mimeType: typeof mimeRaw === 'string' ? mimeRaw : 'application/octet-stream',
      name: typeof nameRaw === 'string' && nameRaw ? nameRaw : undefined,
    })
  }
  return out
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 本体                                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * 受信メールサービスの POST を、inbound-email に渡せる形に正規化する。
 *
 * **解析はしない。** 誰から来た何というメールで、本文と添付がこれ、という事実だけを整える。
 */
export function normalizeWebhookPayload(raw: Record<string, unknown>): NormalizedMail {
  const notes: string[] = []
  const provider = detectProvider(raw)
  if (provider === 'generic') notes.push('provider=generic（既知の特徴キーが無い）')
  const map = FIELD_MAP[provider]

  const envelopeFrom = extractAddress(pick(raw, map.from))
  const headerSubject = pick(raw, map.subject)
  const plain = pick(raw, map.text)
  const html = pick(raw, map.html)

  // プレーンが無ければ HTML を渡す。タグ落としは inbound-email 側が持っているので
  // ここでは触らない（落とし方を2か所に持つと必ずズレる）。
  let body = plain || html
  if (!plain && html) notes.push('プレーン本文が無いため HTML を渡した')

  // 転送ヘッダの展開。ここが本来の仕事。
  const fw = unwrapForwarded(body)
  let from = envelopeFrom
  let subject = headerSubject
  if (fw.forwarded) {
    body = fw.body
    from = fw.from
    if (fw.subject) subject = fw.subject
    notes.push(`転送ヘッダを展開（差出人 ${envelopeFrom || '不明'} → ${from}）`)
  }

  const receivedRaw = pick(raw, RECEIVED_AT_KEYS)
  let emailReceivedAt: string | null = null
  if (receivedRaw) {
    const d = new Date(receivedRaw)
    if (!Number.isNaN(d.getTime())) emailReceivedAt = d.toISOString()
    else notes.push(`受信日時を解釈できなかった: ${receivedRaw.slice(0, 40)}`)
  }

  const attachments = normalizeAttachments(
    raw.attachments ?? raw.Attachments ?? raw.attachmentsJson,
  )

  return { from, envelopeFrom, subject, body, emailReceivedAt, attachments, forwarded: fw.forwarded, provider, notes }
}

/**
 * 正規化結果を inbound-email の POST ボディに変換する。
 *
 * キー名は inbound-email の先頭コメント（`type, from, subject, body, attachmentsJson …`）が正。
 * ここを変えるときは必ずあちらを読んでから変えること。
 */
export function toInboundEmailFields(mail: NormalizedMail, dataEnv: 'prod' | 'demo'): Record<string, string> {
  const fields: Record<string, string> = {
    type: 'candidate',
    from: mail.from,
    subject: mail.subject,
    body: mail.body,
    data_env: dataEnv,
  }
  if (mail.emailReceivedAt) fields.email_received_at = mail.emailReceivedAt
  if (mail.attachments.length > 0) fields.attachmentsJson = JSON.stringify(mail.attachments)
  return fields
}

/**
 * 「このまま渡すと静かに捨てられる」状態を検出する。
 *
 * 返り値が null でなければ、それが**止める理由**。呼び出し側は 422 で返して
 * メールサービス側に再送させる／管理者に見せる。黙って 200 を返してはいけない。
 *
 * @param ownDomain 自社ドメイン（`app_config.own_email_domain`）。未設定なら空文字
 */
export function detectSilentDropRisk(mail: NormalizedMail, ownDomain: string): string | null {
  if (!mail.from) {
    return '差出人アドレスを取り出せなかった（転送ヘッダの形が未知の可能性）'
  }
  if (!mail.body.trim() && mail.attachments.length === 0) {
    return '本文も添付も空'
  }
  const dom = ownDomain.trim().toLowerCase()
  if (dom && mail.from.split('@')[1] === dom) {
    // inbound-email はこれを OWN_DOMAIN で捨てる。転送経路では「復元できていない」
    // ことのほぼ確実な証拠なので、捨てられる前にここで止める。
    return `差出人が自社ドメイン（${dom}）のまま。転送ヘッダから原メールの差出人を復元できていない`
  }
  return null
}
