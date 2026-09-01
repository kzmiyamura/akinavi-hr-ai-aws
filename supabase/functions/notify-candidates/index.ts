// Supabase Edge Function: notify-candidates
// 通知ルール（notification_rules）に合致する新着人材が現れたらメール通知する。
// pg_cron 5分間隔（add_notify_cron.sql）。AI不使用・ルールベースのみ。
//
// メール送信: Microsoft Graph sendMail。
//   トークンは通知専用キー graph_rt_notify を使う（poll-email とは分離）。
//   ※ Mail.Send スコープが必要。設定画面からのMicrosoft再連携（再同意）後に有効になる。
//   未同意の間は送信せず app_config.notify_last_error に理由を記録する。
//
//   【なぜ分離したか】2026-08-18
//   以前は poll-email と同じ graph_rt_human_prod を共有し、通知側もそこへ書き戻していた。
//   そのため 8/17 に通知(Mail.Send)の再同意を個人アカウントで行った際、受信用トークンが
//   個人アカウントのもので上書きされ、poll-email が丸1日「別のメールボックスを正常に
//   巡回して未読0件」を返し続けた（エラーは一切出ないため検知できなかった）。
//   通知の再連携が受信を壊さないよう、キーを分ける。
//
// 環境変数: GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / GRAPH_REFRESH_TOKEN_HUMAN(初期値)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchesRule, matchedSkills, type CandidateLite, type NotifyRule } from './match.ts'

const CLIENT_ID = Deno.env.get('GRAPH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? ''
const SEND_SCOPE = 'offline_access Mail.Read Mail.ReadWrite Mail.Send'
/** 通知送信専用のリフレッシュトークン。poll-email とは共有しない（書き戻し先もここだけ） */
const TOKEN_CONFIG_KEY = 'graph_rt_notify'
/** 初回の種取り専用。poll-email の受信用キー。読むだけで、絶対に書き戻さない */
const TOKEN_SEED_KEY = 'graph_rt_human_prod'
const TOKEN_SECRET_FALLBACK = 'GRAPH_REFRESH_TOKEN_HUMAN'
/** 初回・長期停止後の暴発防止: この時間より昔の人材は通知対象にしない */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000
/** 1周回で見る人材の上限。超えた分は捨てずに次周へ繰り越す（下の processedUpTo 参照） */
const CANDIDATE_FETCH_LIMIT = 300

const corsHeaders = { 'Access-Control-Allow-Origin': '*' }

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// deno-lint-ignore no-explicit-any
type Sb = any

async function getConfig(sb: Sb, key: string): Promise<string> {
  const { data } = await sb.from('app_config').select('value').eq('key', key).maybeSingle()
  return data?.value ?? ''
}

async function setConfig(sb: Sb, key: string, value: string): Promise<void> {
  await sb.from('app_config').upsert({ key, value }, { onConflict: 'key' })
}

/**
 * 通知送信用アクセストークンを取る。
 *
 * 参照順: graph_rt_notify → graph_rt_human_prod（初回の種取り） → Secret。
 * 種取りは「コピーして使う」だけで、poll-email 側のキーは読むのみ・書き換えない。
 * 初回実行で自分用の新しいリフレッシュトークンを graph_rt_notify に持つので、
 * 以後は完全に独立する（旧トークンには猶予があるため無停止で移行できる）。
 */
async function getAccessTokenForSend(sb: Sb): Promise<{ accessToken: string } | { error: string }> {
  const stored = await getConfig(sb, TOKEN_CONFIG_KEY)
  const seeded = stored || await getConfig(sb, TOKEN_SEED_KEY)
  const refreshToken = seeded || (Deno.env.get(TOKEN_SECRET_FALLBACK) ?? '')
  if (!refreshToken) return { error: 'リフレッシュトークン未設定' }
  if (!stored) console.log('[notify] graph_rt_notify が未設定のため受信用キーから種取りする（今回限り）')
  const res = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SEND_SCOPE,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    // 保存済みトークンが失効した場合、放置すると stored が非空のまま再種取りされず
    // 通知が永久に止まる。空にして次回に受信用キーから取り直させる（自己修復）。
    // 失敗したリフレッシュはトークンを消費しないので、種側に副作用は無い。
    if (stored) {
      await setConfig(sb, TOKEN_CONFIG_KEY, '')
      console.warn('[notify] 保存済みトークンが失効。graph_rt_notify を空にして次回再取得する')
    }
    // Mail.Send 未同意（invalid_grant / consent_required）はここで判明する
    return { error: `トークン取得失敗(${res.status}): ${body.slice(0, 300)}` }
  }
  const j = await res.json()
  // ローテーション保存。書き戻し先は通知専用キーのみ。
  // ここで受信用キー(graph_rt_human_prod)へ書くと、通知の再連携が受信を壊す事故が再発する。
  if (j.refresh_token) await setConfig(sb, TOKEN_CONFIG_KEY, j.refresh_token)
  return { accessToken: j.access_token }
}

/**
 * メール取り込みの死活監視。
 *
 * 2026-08-28、Outlook 側が人間確認（bot判定）を出して poll-email が7時間止まった。
 * エラーは一切出ず、人材がゼロ件になるだけなので誰も気づけない。同種の事故は
 * 8/17 にも起きている（受信トークンが個人アカウントで上書きされ、丸1日「未読0件」を
 * 返し続けた）。**静かに止まる**のがこの仕組みの弱点なので、無音を異常として検知する。
 *
 * 判定: 直近の人材登録から STALL_HOURS 以上経っていたら通報。
 * 再送は RE_ALERT_HOURS ごと（止まっている間ずっと5分おきに送らないため）。
 * 復旧したら次に止まったとき即座に通報できるよう記録を消す。
 */
const STALL_DEFAULT_HOURS = 3
const RE_ALERT_HOURS = 6
/** 判定してよい時間帯（JST）。夜と休日は案件メールが来ないので無音が正常。
 *  実測（30日）では毎晩9〜12時間止まる。夜も見張ると毎晩誤報になる。
 *  日中に止まったのは 8/18 と 8/28 の2回だけで、どちらも本物の障害だった。 */
const BUSINESS_START_JST = 10
const BUSINESS_END_JST = 20

function jstNow(): { hour: number; day: number } {
  const d = new Date(Date.now() + 9 * 3600_000)
  return { hour: d.getUTCHours(), day: d.getUTCDay() }
}

async function checkInboundStall(sb: Sb, notifyTo: string): Promise<Record<string, unknown>> {
  const { hour, day } = jstNow()
  if (day === 0 || day === 6) return { checked: false, reason: 'weekend' }
  if (hour < BUSINESS_START_JST || hour >= BUSINESS_END_JST) return { checked: false, reason: 'off_hours' }

  const hours = Number(await getConfig(sb, 'inbound_stall_alert_hours')) || STALL_DEFAULT_HOURS
  const to = (await getConfig(sb, 'inbound_stall_alert_email')) || notifyTo
  if (!to) return { checked: false, reason: 'no_recipient' }

  const { data: last } = await sb
    .from('candidates')
    .select('created_at')
    .eq('data_env', 'prod')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!last?.created_at) return { checked: false, reason: 'no_candidates' }

  const silentMs = Date.now() - new Date(last.created_at).getTime()
  const silentHours = silentMs / 3600_000
  const lastAlert = await getConfig(sb, 'inbound_stall_last_alert_at')

  if (silentHours < hours) {
    // 復旧している。次の停止で即通報できるよう記録を消す
    if (lastAlert) await setConfig(sb, 'inbound_stall_last_alert_at', '')
    return { stalled: false, silentHours: Number(silentHours.toFixed(1)) }
  }

  // 通報済みで、まだ再送間隔に達していないなら黙る
  if (lastAlert && Date.now() - new Date(lastAlert).getTime() < RE_ALERT_HOURS * 3600_000) {
    return { stalled: true, silentHours: Number(silentHours.toFixed(1)), alerted: false, reason: 'throttled' }
  }

  const token = await getAccessTokenForSend(sb)
  if ('error' in token) return { stalled: true, alerted: false, reason: `token: ${token.error}` }

  const err = await sendMail(token.accessToken, to,
    `[AkiNavi] メール取り込みが ${silentHours.toFixed(1)} 時間止まっています`,
    `人材の新規登録が ${silentHours.toFixed(1)} 時間ありません（しきい値 ${hours} 時間）。\n\n` +
    `最後の登録: ${last.created_at}\n\n` +
    `よくある原因:\n` +
    `・Outlook 側が人間確認（bot判定）を出している → ブラウザで Outlook を開いて確認する\n` +
    `・Microsoft のトークンが失効した → 設定画面から再連携する\n` +
    `・受信箱に未読が無いだけ（正常）\n\n` +
    `実績として、この停止は人が手でサインインするまで復旧しません（8/18・8/28 とも）。\n` +
    `判定は平日 JST ${BUSINESS_START_JST}:00〜${BUSINESS_END_JST}:00 のみ（夜間・休日の無音は正常なため）。\n` +
    `この通知は復旧するまで ${RE_ALERT_HOURS} 時間おきに届きます。`)
  if (err) return { stalled: true, alerted: false, reason: err }

  await setConfig(sb, 'inbound_stall_last_alert_at', new Date().toISOString())
  return { stalled: true, silentHours: Number(silentHours.toFixed(1)), alerted: true, to }
}

/**
 * ストレージ容量の監視（2026-08-30 追加）。
 *
 * 実害: raw/（受信添付の控え）が掃除の不具合で 1.7GB まで膨らみ、無料枠1GBを超過。
 * 2026-08-30 にプロジェクト全体が 402 を返して停止した（Fair Use Policy）。
 * このとき実サイズは既に 204MB まで削っていたが、Supabase が見るのは
 * **請求期間の平均**（Average in period）なので、超過した数日が平均を押し上げたまま
 * 解除されず、Pro へのアップグレードでしか復旧できなかった。
 *
 * つまり「超えてから減らす」では手遅れになる。超える前に気づくための監視。
 * 実サイズが枠の一定割合を超えたら通報する。
 */
const STORAGE_ALERT_DEFAULT_PCT = 70
const STORAGE_ALERT_INTERVAL_H = 24

async function checkStorageQuota(sb: Sb, notifyTo: string): Promise<Record<string, unknown>> {
  const to = (await getConfig(sb, 'inbound_stall_alert_email')) || notifyTo
  if (!to) return { checked: false, reason: 'no_recipient' }

  // 枠は契約プランで変わるので設定で持つ（Free=1GB / Pro=100GB）
  const quota = Number(await getConfig(sb, 'storage_quota_bytes')) || 1_073_741_824
  const alertPct = Number(await getConfig(sb, 'storage_alert_pct')) || STORAGE_ALERT_DEFAULT_PCT

  const { data, error } = await sb.rpc('storage_usage')
  if (error) return { checked: false, reason: `rpc: ${error.message}` }
  const rows = (data ?? []) as Array<{ bucket: string; files: number; bytes: number }>
  const bytes = rows.reduce((s, r) => s + Number(r.bytes ?? 0), 0)
  const pct = quota > 0 ? (100 * bytes) / quota : 0
  const mb = (n: number) => (n / 1024 / 1024).toFixed(0)

  if (pct < alertPct) return { pct: Number(pct.toFixed(1)), mb: mb(bytes), alerted: false }

  // 1日1回まで
  const last = await getConfig(sb, 'storage_alert_last_at')
  if (last && Date.now() - new Date(last).getTime() < STORAGE_ALERT_INTERVAL_H * 3600_000) {
    return { pct: Number(pct.toFixed(1)), mb: mb(bytes), alerted: false, reason: 'throttled' }
  }

  const token = await getAccessTokenForSend(sb)
  if ('error' in token) return { pct: Number(pct.toFixed(1)), alerted: false, reason: `token: ${token.error}` }

  const detail = rows.map((r) => `  ${r.bucket}: ${r.files}ファイル ${mb(Number(r.bytes))}MB`).join('\n')
  const err = await sendMail(token.accessToken, to,
    `[AkiNavi] ストレージが枠の ${pct.toFixed(0)}% に達しています`,
    `ストレージ使用量: ${mb(bytes)}MB / ${mb(quota)}MB（${pct.toFixed(1)}%）\n\n${detail}\n\n` +
    `超えるとプロジェクト全体が 402 を返して停止します（2026-08-30 に実際に停止しました）。\n` +
    `判定は「請求期間の平均」なので、超えてから減らしても即座には解除されません。\n` +
    `いま減らしてください。\n\n` +
    `減らし方:\n` +
    `・app_config.raw_retention_days（受信添付の控え・既定1日）を短くする\n` +
    `・app_config.storage_retention_days（経歴書・既定7日）を短くする\n` +
    `・設定画面の「ファイル保持期間」からも変更できます\n\n` +
    `この通知は ${STORAGE_ALERT_INTERVAL_H} 時間おきです。枠は app_config.storage_quota_bytes で変えられます。`)
  if (err) return { pct: Number(pct.toFixed(1)), alerted: false, reason: err }

  await setConfig(sb, 'storage_alert_last_at', new Date().toISOString())
  return { pct: Number(pct.toFixed(1)), mb: mb(bytes), alerted: true, to }
}

async function sendMail(accessToken: string, to: string, subject: string, text: string): Promise<string | null> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  })
  if (res.ok || res.status === 202) return null
  return `sendMail失敗(${res.status}): ${(await res.text()).slice(0, 300)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  try {
    if ((await getConfig(sb, 'notify_enabled')) === 'false') {
      return json(200, { ok: true, skipped: 'disabled' })
    }

    // ルール取得（テーブル未作成=マイグレーション前は静かにスキップ）
    const { data: ruleRows, error: ruleErr } = await sb
      .from('notification_rules')
      .select('id, label, name_keyword, skill_keywords, station_keyword, notify_email, enabled, data_env')
      .eq('enabled', true)
    if (ruleErr) {
      if (/notification_rules/.test(ruleErr.message)) {
        return json(200, { ok: true, skipped: 'table_missing' })
      }
      throw new Error(ruleErr.message)
    }
    const rules = (ruleRows ?? []) as NotifyRule[]

    // 死活監視は人材ルールと独立に毎回まわす（ルールが0件でも取り込みの停止は知りたい）。
    // 失敗しても通知本体を止めない。
    let stall: Record<string, unknown>
    try {
      stall = await checkInboundStall(sb, rules[0]?.notify_email ?? '')
    } catch (e) {
      stall = { checked: false, reason: String(e).slice(0, 200) }
    }
    if (stall.alerted) console.log('[notify] 取り込み停止を通報:', JSON.stringify(stall))

    // ストレージ容量の監視も人材ルールと独立にまわす（失敗しても通知本体を止めない）
    let storage: Record<string, unknown>
    try {
      storage = await checkStorageQuota(sb, rules[0]?.notify_email ?? '')
    } catch (e) {
      storage = { checked: false, reason: String(e).slice(0, 200) }
    }
    if (storage.alerted) console.log('[notify] ストレージ逼迫を通報:', JSON.stringify(storage))

    if (rules.length === 0) return json(200, { ok: true, matched: 0, reason: 'no_rules', stall, storage })

    // チェック窓: 前回実行時刻から（上限24時間。復旧直後の大量流入で過去分を丸ごと通知しない）
    const runStartedAt = new Date().toISOString()
    const lastStr = await getConfig(sb, 'notify_last_checked_at')
    const floor = Date.now() - MAX_LOOKBACK_MS
    const last = Math.max(lastStr ? Date.parse(lastStr) || floor : floor, floor)
    const sinceIso = new Date(last).toISOString()

    // 新着・更新された人材（email一致の再登録UPDATEも「現れた」に含める）
    //
    // ⚠ 取得は「更新の古い順」で、上限に達したらウォーターマークを**最後に見た行まで**しか
    // 進めない。以前は並び順なしの `.limit(300)` で、超過分を黙って捨てたうえで
    // ウォーターマークだけ実行時刻まで進めていたため、**あふれた人材は永久に通知されなかった**。
    // 実害: 2026-08-21 12:04 JST に保守作業で 1,234 件を一括 UPDATE した際、その窓に入った
    // 大阪ルール該当者2名（KI / I.T）が通知されずに落ちた。
    // 一括更新は普通に起きる（再マッチ・バックフィル・移行）ので、落とさず次の周回へ繰り越す。
    const envs = [...new Set(rules.map((r) => r.data_env))]
    const cands: CandidateLite[] = []
    /** この周回で実際に見終わった時刻。上限に達したらここまでしかウォーターマークを進めない */
    let processedUpTo: string | null = null
    let truncated = false
    for (const env of envs) {
      const { data, error } = await sb
        .from('candidates')
        .select('id, name, skills, raw_profile, data_env, created_at, updated_at')
        .eq('data_env', env)
        .is('merged_into', null)
        .or(`created_at.gt.${sinceIso},updated_at.gt.${sinceIso}`)
        .order('updated_at', { ascending: true })
        .limit(CANDIDATE_FETCH_LIMIT)
      if (error) throw new Error(error.message)
      const rows = data ?? []
      if (rows.length >= CANDIDATE_FETCH_LIMIT) {
        truncated = true
        // 取り切れなかった。最後の行の updated_at までを「見た」とみなして次周に繰り越す
        const lastSeen = rows[rows.length - 1]?.updated_at as string | undefined
        if (lastSeen && (processedUpTo === null || lastSeen < processedUpTo)) processedUpTo = lastSeen
      }
      for (const row of rows) {
        const rp = (row.raw_profile ?? {}) as Record<string, unknown>
        cands.push({
          id: String(row.id),
          name: String(row.name ?? ''),
          skills: Array.isArray(row.skills) ? (row.skills as string[]) : [],
          station: `${rp.nearestStation ?? ''} ${rp.prefecture ?? ''}`,
          data_env: String(row.data_env),
        })
      }
    }
    // 途中までしか見ていないならその時刻、全部見たなら実行開始時刻へ進める
    const nextWatermark = truncated && processedUpTo ? processedUpTo : runStartedAt
    if (truncated) {
      console.log(`[notify] 取得上限 ${CANDIDATE_FETCH_LIMIT} に到達。${nextWatermark} まで処理して次周に繰り越す`)
    }

    if (cands.length === 0) {
      await setConfig(sb, 'notify_last_checked_at', nextWatermark)
      return json(200, { ok: true, matched: 0, checked: 0, stall, storage })
    }

    // ルールごとのマッチ（通知済みは除外）
    const perRule = new Map<string, { rule: NotifyRule; hits: CandidateLite[] }>()
    for (const rule of rules) {
      const hits = cands.filter((c) => matchesRule(rule, c))
      if (hits.length === 0) continue
      const { data: logged } = await sb
        .from('notification_log')
        .select('candidate_id')
        .eq('rule_id', rule.id)
        .in('candidate_id', hits.map((h) => h.id))
      const done = new Set((logged ?? []).map((l: { candidate_id: string }) => l.candidate_id))
      const fresh = hits.filter((h) => !done.has(h.id))
      if (fresh.length > 0) perRule.set(rule.id, { rule, hits: fresh })
    }
    if (perRule.size === 0) {
      await setConfig(sb, 'notify_last_checked_at', nextWatermark)
      return json(200, { ok: true, matched: 0, checked: cands.length, stall, storage })
    }

    // 送信トークン取得（Mail.Send 未同意ならここで止まる → エラーを画面から見える場所に記録）
    const token = await getAccessTokenForSend(sb)
    if ('error' in token) {
      await setConfig(sb, 'notify_last_error',
        `メール送信不可: ${token.error}（設定画面からMicrosoft再連携でMail.Send権限の同意が必要な可能性）`)
      console.error('[notify] token error:', token.error)
      // last_checked は進めない（同意後に再送させる）
      return json(200, { ok: false, matched: perRule.size, sent: 0, error: 'token' })
    }

    let sent = 0
    const errors: string[] = []
    for (const { rule, hits } of perRule.values()) {
      const title = rule.label || [rule.name_keyword, rule.skill_keywords.join('+'), rule.station_keyword]
        .filter(Boolean).join(' / ')
      // 「なぜ通知されたか」を先に出す（2026-09-01）。
      // 以前はスキルを先頭10件だけ並べており、24個中23番目に Java がある人が
      // 「C#でもJavaでもない人に通知が来た」と誤解される事故があった。
      // 合致したスキルを明示し、残りは件数で示す。
      const SKILL_PREVIEW = 10
      const lines = hits.map((h) => {
        const matched = matchedSkills(rule, h)
        const rest = h.skills.filter((s) => !matched.includes(s))
        const shown = rest.slice(0, SKILL_PREVIEW)
        const more = rest.length - shown.length
        return [
          `・${h.name}${h.station.trim() ? `（${h.station.trim()}）` : ''}`,
          `  該当: ${matched.join(', ') || '（スキル以外の条件で合致）'}`,
          `  他のスキル: ${shown.join(', ') || '－'}${more > 0 ? ` ほか${more}件` : ''}`,
        ].join('\n')
      })
      const body = [
        `通知ルール「${title}」に合致する人材が登録・更新されました（${hits.length}名）。`,
        '',
        ...lines,
        '',
        '— AkiNavi HR-AI 自動通知',
      ].join('\n')
      const err = await sendMail(token.accessToken, rule.notify_email,
        `【AkiNavi】人材通知: ${title}（${hits.length}名）`, body)
      if (err) {
        errors.push(`${rule.id}: ${err}`)
        continue
      }
      sent++
      await sb.from('notification_log').upsert(
        hits.map((h) => ({
          rule_id: rule.id,
          candidate_id: h.id,
          candidate_name: h.name,
          sent_to: rule.notify_email,
        })),
        { onConflict: 'rule_id,candidate_id', ignoreDuplicates: true },
      )
    }

    await setConfig(sb, 'notify_last_checked_at', nextWatermark)
    await setConfig(sb, 'notify_last_error', errors.length > 0 ? errors.join(' | ').slice(0, 500) : '')
    console.log(`[notify] checked=${cands.length} rules=${rules.length} sent=${sent} errors=${errors.length}`)
    return json(200, { ok: errors.length === 0, checked: cands.length, sent, errors, stall, storage })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[notify] FATAL:', msg)
    return json(500, { ok: false, error: msg })
  }
})
