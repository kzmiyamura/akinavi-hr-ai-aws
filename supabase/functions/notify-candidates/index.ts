// Supabase Edge Function: notify-candidates
// 通知ルール（notification_rules）に合致する新着人材が現れたらメール通知する。
// pg_cron 5分間隔（add_notify_cron.sql）。AI不使用・ルールベースのみ。
//
// メール送信: Microsoft Graph sendMail（human/prodアカウント・poll-emailと同じトークンを使用）
//   ※ Mail.Send スコープが必要。設定画面からのMicrosoft再連携（再同意）後に有効になる。
//   未同意の間は送信せず app_config.notify_last_error に理由を記録する。
//
// 環境変数: GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / GRAPH_REFRESH_TOKEN_HUMAN(初期値)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchesRule, type CandidateLite, type NotifyRule } from './match.ts'

const CLIENT_ID = Deno.env.get('GRAPH_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET') ?? ''
const SEND_SCOPE = 'offline_access Mail.Read Mail.ReadWrite Mail.Send'
const TOKEN_CONFIG_KEY = 'graph_rt_human_prod'
const TOKEN_SECRET_FALLBACK = 'GRAPH_REFRESH_TOKEN_HUMAN'
/** 初回・長期停止後の暴発防止: この時間より昔の人材は通知対象にしない */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

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

/** poll-email と同じリフレッシュトークン運用（app_config優先・Secretは初期値） */
async function getAccessTokenForSend(sb: Sb): Promise<{ accessToken: string } | { error: string }> {
  const stored = await getConfig(sb, TOKEN_CONFIG_KEY)
  const refreshToken = stored || (Deno.env.get(TOKEN_SECRET_FALLBACK) ?? '')
  if (!refreshToken) return { error: 'リフレッシュトークン未設定' }
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
    // Mail.Send 未同意（invalid_grant / consent_required）はここで判明する
    return { error: `トークン取得失敗(${res.status}): ${body.slice(0, 300)}` }
  }
  const j = await res.json()
  // ローテーション保存（poll-email と共有のキー。旧トークンにも猶予があるため並走しても実害は出にくい）
  if (j.refresh_token) await setConfig(sb, TOKEN_CONFIG_KEY, j.refresh_token)
  return { accessToken: j.access_token }
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
    if (rules.length === 0) return json(200, { ok: true, matched: 0, reason: 'no_rules' })

    // チェック窓: 前回実行時刻から（上限24時間。復旧直後の大量流入で過去分を丸ごと通知しない）
    const runStartedAt = new Date().toISOString()
    const lastStr = await getConfig(sb, 'notify_last_checked_at')
    const floor = Date.now() - MAX_LOOKBACK_MS
    const last = Math.max(lastStr ? Date.parse(lastStr) || floor : floor, floor)
    const sinceIso = new Date(last).toISOString()

    // 新着・更新された人材（email一致の再登録UPDATEも「現れた」に含める）
    const envs = [...new Set(rules.map((r) => r.data_env))]
    const cands: CandidateLite[] = []
    for (const env of envs) {
      const { data, error } = await sb
        .from('candidates')
        .select('id, name, skills, raw_profile, data_env, created_at, updated_at')
        .eq('data_env', env)
        .is('merged_into', null)
        .or(`created_at.gt.${sinceIso},updated_at.gt.${sinceIso}`)
        .limit(300)
      if (error) throw new Error(error.message)
      for (const row of data ?? []) {
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
    if (cands.length === 0) {
      await setConfig(sb, 'notify_last_checked_at', runStartedAt)
      return json(200, { ok: true, matched: 0, checked: 0 })
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
      await setConfig(sb, 'notify_last_checked_at', runStartedAt)
      return json(200, { ok: true, matched: 0, checked: cands.length })
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
      const lines = hits.map((h) =>
        `・${h.name}${h.station.trim() ? `（${h.station.trim()}）` : ''}\n  スキル: ${h.skills.slice(0, 10).join(', ') || '－'}`)
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

    await setConfig(sb, 'notify_last_checked_at', runStartedAt)
    await setConfig(sb, 'notify_last_error', errors.length > 0 ? errors.join(' | ').slice(0, 500) : '')
    console.log(`[notify] checked=${cands.length} rules=${rules.length} sent=${sent} errors=${errors.length}`)
    return json(200, { ok: errors.length === 0, checked: cands.length, sent, errors })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[notify] FATAL:', msg)
    return json(500, { ok: false, error: msg })
  }
})
