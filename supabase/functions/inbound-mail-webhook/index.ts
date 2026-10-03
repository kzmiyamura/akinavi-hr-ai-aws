/**
 * Supabase Edge Function: 受信メールサービスの Webhook → inbound-email
 *
 * ## なぜ別の関数なのか
 *
 * **inbound-email を一切改造しない**ため。今の本番は Microsoft Graph ポーリング
 * （poll-email → inbound-email）で動いていて、ここを触ると稼働中の取り込みが止まる。
 * この関数は前段のアダプタとして足すだけなので、既存経路への影響がゼロになる。
 *
 *   【今・無改造】 Outlook ──Graph──> poll-email ──┐
 *   【追加】      顧客メール ─転送─> 受信サービス ─> inbound-mail-webhook ─┴─> inbound-email
 *
 * ## 認証
 *
 * `verify_jwt = false`（外部サービスは JWT を持てない）。代わりに共有シークレットで守る。
 *   - ヘッダ `X-Webhook-Secret: <秘密>`  … 推奨
 *   - クエリ `?secret=<秘密>`            … ヘッダを付けられないサービス向けの逃げ道
 * 秘密は Secret `INBOUND_WEBHOOK_SECRET`。**未設定なら全リクエストを拒否する**
 * （設定漏れで誰でも投稿できる状態になるのを防ぐ。開けっぱなしより閉じて落ちる方が安全）。
 *
 * ⚠ クエリで渡すと受信サービスのログや Supabase のアクセスログに秘密が残る。
 *    ヘッダが使えるサービスなら必ずヘッダを使う。
 *
 * ## 返す HTTP ステータスの考え方
 *
 * 受信メールサービスは 2xx 以外だと再送してくれる。だから:
 *   - 200 … inbound-email に渡せた（結果の成否は inbound-email の責任）
 *   - 401 … 秘密が違う（再送されても意味が無いが、気付けるよう残す）
 *   - 422 … **このまま渡すと静かに捨てられる**形だった。黙って 200 を返さない
 *   - 502 … inbound-email 側が落ちた。再送してほしいので 5xx
 *
 * 「静かに 200」を返さないのがこの関数の一番大事な性質。過去に無言の取りこぼしで
 * 丸1日気付けなかったことがある（8/17 のトークン上書き）。
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-webhook-secret',
}

import {
  normalizeWebhookPayload,
  toInboundEmailFields,
  detectSilentDropRisk,
} from './normalize.ts'

/**
 * 長さに依存しない定数時間比較。
 * 素の `===` でも実害は考えにくいが、秘密の比較でタイミング差を残す理由も無い。
 */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `app_config.own_email_domain` を読む。読めなければ空文字（判定を諦める） */
async function loadOwnEmailDomain(supabaseUrl: string, serviceKey: string): Promise<string> {
  if (!supabaseUrl || !serviceKey) return ''
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/app_config?key=eq.own_email_domain&select=value`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    )
    if (!res.ok) return ''
    const rows = (await res.json()) as Array<{ value?: unknown }>
    const v = rows[0]?.value
    if (typeof v === 'string') return v
    // value が jsonb の場合は文字列化されて来ることがある
    return v == null ? '' : String(v).replace(/^"|"$/g, '')
  } catch {
    return ''
  }
}

/** 受け取ったボディを content-type に応じて素の key→value に均す */
async function readRawBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await req.text())
    const out: Record<string, unknown> = {}
    for (const [k, v] of params.entries()) out[k] = v
    return out
  }
  if (ct.includes('multipart/form-data')) {
    // SendGrid Inbound Parse / Mailgun はこれ。添付はファイルパートで来る。
    const fd = await req.formData()
    const out: Record<string, unknown> = {}
    const files: Array<{ data: string; mimeType: string; name?: string }> = []
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') { out[k] = v; continue }
      if (v instanceof Blob) {
        const bytes = new Uint8Array(await v.arrayBuffer())
        files.push({
          data: base64FromBytes(bytes),
          mimeType: v.type || 'application/octet-stream',
          name: v instanceof File && v.name ? v.name : k,
        })
      }
    }
    // normalizeAttachments が読む形に入れる（キー名は normalize.ts 側と対応）
    if (files.length > 0) out.attachments = files
    return out
  }
  return (await req.json()) as Record<string, unknown>
}

/** 大きい添付でスタックを溢れさせないよう分割して base64 にする */
function base64FromBytes(bytes: Uint8Array): string {
  const chunk = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST のみ' })

  const rid = crypto.randomUUID().slice(0, 8)

  // ── 認証 ──────────────────────────────────────────────────────────────
  const expected = Deno.env.get('INBOUND_WEBHOOK_SECRET') ?? ''
  if (!expected) {
    console.error(`[${rid}] INBOUND_WEBHOOK_SECRET が未設定。全リクエストを拒否する`)
    return json(503, { ok: false, error: 'webhook secret 未設定' })
  }
  let given = req.headers.get('x-webhook-secret') ?? ''
  if (!given) {
    try { given = new URL(req.url).searchParams.get('secret') ?? '' } catch { /* ignore */ }
  }
  if (!secretEquals(given, expected)) {
    console.warn(`[${rid}] secret 不一致`)
    return json(401, { ok: false, error: 'unauthorized' })
  }

  const url = (() => { try { return new URL(req.url) } catch { return null } })()
  const dataEnv = (url?.searchParams.get('data_env') === 'demo' ? 'demo' : 'prod') as 'prod' | 'demo'
  /** 検証用。正規化結果だけ返して inbound-email には渡さない */
  const dryRun = url?.searchParams.get('dry_run') === 'true'

  try {
    const raw = await readRawBody(req)
    const mail = normalizeWebhookPayload(raw)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const ownDomain = dataEnv === 'prod' ? await loadOwnEmailDomain(supabaseUrl, serviceKey) : ''

    // 受け取った事実を必ず1行残す。本文と添付は中身を出さず件数と長さだけ。
    console.log(`[${rid}] normalized`, JSON.stringify({
      provider: mail.provider,
      forwarded: mail.forwarded,
      envelope_from: mail.envelopeFrom,
      from: mail.from,
      subject: mail.subject.slice(0, 80),
      body_len: mail.body.length,
      attachments: mail.attachments.length,
      attachment_names: mail.attachments.map(a => a.name ?? '(名前なし)'),
      data_env: dataEnv,
      notes: mail.notes,
    }))

    const risk = detectSilentDropRisk(mail, ownDomain)
    if (risk) {
      console.error(`[${rid}] 渡さずに止めた: ${risk}`)
      return json(422, {
        ok: false, rid, error: risk,
        hint: '転送ヘッダの形が未知の可能性。normalize.ts の HEADER_KEYS を確認する',
        provider: mail.provider, forwarded: mail.forwarded,
        envelope_from: mail.envelopeFrom, from: mail.from,
      })
    }

    const fields = toInboundEmailFields(mail, dataEnv)

    if (dryRun) {
      return json(200, {
        ok: true, rid, dry_run: true,
        provider: mail.provider, forwarded: mail.forwarded,
        from: mail.from, envelope_from: mail.envelopeFrom, subject: mail.subject,
        body_len: mail.body.length, body_head: mail.body.slice(0, 300),
        attachments: mail.attachments.map(a => ({ name: a.name, mimeType: a.mimeType, bytes: a.data.length })),
        notes: mail.notes,
      })
    }

    if (!supabaseUrl || !serviceKey) {
      console.error(`[${rid}] SUPABASE_URL / SERVICE_ROLE_KEY が無く転送できない`)
      return json(503, { ok: false, rid, error: 'サーバ設定不足' })
    }

    // inbound-email は verify_jwt = true なので service role key を付けて呼ぶ。
    // ボディは form-urlencoded（あちらが最初に見る形で、JSON より素直に通る）。
    const res = await fetch(`${supabaseUrl}/functions/v1/inbound-email`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    })
    const text = await res.text()
    console.log(`[${rid}] inbound-email → ${res.status} ${text.slice(0, 300)}`)

    if (!res.ok) {
      // 5xx を返して受信サービスに再送させる
      return json(502, { ok: false, rid, error: 'inbound-email が失敗', status: res.status, detail: text.slice(0, 500) })
    }
    return json(200, { ok: true, rid, forwarded: mail.forwarded, from: mail.from, inbound: text.slice(0, 500) })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[${rid}] FATAL ${msg}`)
    return json(500, { ok: false, rid, error: msg })
  }
})
