// llm_health.mjs — AI（claude -p）が止まったら管理者にメールで知らせる
//
// 2026-11-23〜25 に claude -p のログインが切れ、AI 呼び出しが約470回 `exit=1` で
// 失敗し続けた。ワーカー自体は pm2 上で online のまま、本文LLMを省略できる人は
// 「上書き」まで進むのでログも止まらない。**誰も気づかず、人が /login するまで丸2日止まっていた**。
//
// 方針:
//   - 呼び出しの成否は caller.mjs の callModel が1回ごとに recordModelResult() で記録する
//     （手動スクリプトからの呼び出しも記録はされるが、メールを送るのはワーカーだけ＝
//      checkAndAlert() を呼ぶのは shadow_worker.mjs だけ）
//   - 「止まった」の判定は **最後の成功から30分以上、成功が1回も無く、失敗が5回以上**。
//     1件の入力だけが落ち続ける（巨大な経歴書など）ケースで鳴らさないよう、
//     timeout と JSON の読み取り失敗は数えない。それらは入力側の問題で、ログイン切れでは出ない
//   - 鳴ったあとも直らなければ12時間ごとに再送。成功が戻ったら「復旧」を1通送る
//   - 状態は ~/.akinavi_llm_health.json に残す。pm2 の再起動で「もう送った」を忘れて
//     同じメールを連発しないため
//
// 送り先は管理者（Free 枠監視 free_plan_watch.mjs と同じ yahoo）。理由は同ファイルの
// MAIL_TO のコメント参照: Resend の共有差出人はアカウント本人宛にしか送れない。
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

export const DOWN_AFTER_MS = 30 * 60 * 1000
export const MIN_FAILS = 5
export const REMIND_EVERY_MS = 12 * 60 * 60 * 1000

/** 数えない失敗（入力ごとの問題で、AI 全体が止まった印ではない） */
export function isTransientError(e) {
  return e instanceof SyntaxError || /timeout/i.test(String(e?.message ?? e))
}

export const emptyHealth = () => ({
  lastOkAt: null, failSince: null, failCount: 0, lastError: null,
  alertedAt: null, lastMailAt: null, recoveredPending: false,
})

/** 1回の呼び出し結果を状態に反映する（純関数） */
export function applyResult(h, ok, error, now) {
  const s = { ...h }
  if (ok) {
    if (s.alertedAt) s.recoveredPending = true
    s.lastOkAt = now
    s.failSince = null
    s.failCount = 0
    return s
  }
  if (s.failSince == null) s.failSince = now
  s.failCount += 1
  s.lastError = String(error ?? '').slice(0, 500)
  return s
}

/**
 * 今送るべきメールの種類を返す（純関数）。'down' | 'reminder' | 'recovered' | null
 * 送ったあとの状態は markSent() で作る
 */
export function decide(h, now) {
  if (h.recoveredPending) return 'recovered'
  if (h.failSince == null) return null
  if (!h.alertedAt) {
    return h.failCount >= MIN_FAILS && now - h.failSince >= DOWN_AFTER_MS ? 'down' : null
  }
  return now - (h.lastMailAt ?? h.alertedAt) >= REMIND_EVERY_MS ? 'reminder' : null
}

export function markSent(h, kind, now) {
  const s = { ...h, lastMailAt: now }
  if (kind === 'down') s.alertedAt = now
  if (kind === 'recovered') { s.alertedAt = null; s.recoveredPending = false }
  return s
}

const fmt = (ms) => (ms == null ? '（無し）' : new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }))

export function buildMail(kind, h, now) {
  const mins = h.failSince != null ? Math.round((now - h.failSince) / 60000) : 0
  const looksLogin = /login|auth|401|credential|duration_api_ms":0/i.test(h.lastError ?? '')
  if (kind === 'recovered') {
    return {
      subject: '【AkiNavi】AI校正が復旧しました',
      text: `常駐ワーカーの AI 呼び出し（claude -p）が再び成功しました。\n\n成功: ${fmt(h.lastOkAt)}\n\n` +
        '止まっていた間に届いた人材は、ワーカーが新しい順に順次校正します。',
    }
  }
  const head = kind === 'reminder' ? '【AkiNavi】AI校正がまだ止まっています' : '【AkiNavi】AI校正が止まっています'
  return {
    subject: head,
    text:
      `常駐ワーカーの AI 呼び出し（claude -p）が ${mins}分間、1回も成功していません（失敗 ${h.failCount}回）。\n\n` +
      `最後の成功: ${fmt(h.lastOkAt)}\n失敗の開始: ${fmt(h.failSince)}\n\n` +
      (looksLogin
        ? '■ ログイン切れの可能性が高いです（API に届く前に落ちています）。\n' +
          '  ThinkCentre で Claude Code を開き、/login を実行してください。\n' +
          '  ワーカーの再起動は不要です。次の呼び出しから自動で戻ります。\n\n'
        : '■ 原因は下のエラーを見てください。枠切れなら時間が経てば戻ります。\n\n') +
      `最後のエラー:\n${h.lastError ?? ''}\n\n` +
      '---\nこのメールは scripts/llm_extract/llm_health.mjs（pm2 akinavi-shadow）が送っています。\n' +
      `直らない間は${REMIND_EVERY_MS / 3600000}時間ごとに再送し、復旧したら1通送ります。`,
  }
}

// ---------------------------------------------------------------- 実行時の状態

const STATE_FILE = process.env.LLM_HEALTH_STATE || path.join(os.homedir(), '.akinavi_llm_health.json')
let health = (() => {
  try { return { ...emptyHealth(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } } catch { return emptyHealth() }
})()

/** caller.mjs から1回ごとに呼ぶ。数えない失敗は無視する */
export function recordModelResult(ok, error) {
  if (!ok && isTransientError(error)) return
  health = applyResult(health, ok, ok ? null : (error?.message ?? error), Date.now())
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
function envLocal(key) {
  if (process.env[key]) return process.env[key]
  try {
    for (const raw of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const t = raw.trim()
      const eq = t.indexOf('=')
      if (t && !t.startsWith('#') && eq !== -1 && t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim()
    }
  } catch { /* 無ければ送れない旨を返す */ }
  return undefined
}

const MAIL_TO = process.env.ADMIN_ALERT_TO || process.env.FREE_PLAN_ALERT_TO || 'kzk_mymr@yahoo.co.jp'
const MAIL_FROM = process.env.ADMIN_ALERT_FROM || 'AkiNavi 監視 <onboarding@resend.dev>'

export async function sendAdminMail(subject, text) {
  const key = envLocal('RESEND_API_KEY')
  if (!key) return { ok: false, reason: 'RESEND_API_KEY が .env.local に無い' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject, text }),
    })
    if (!res.ok) return { ok: false, reason: `Resend ${res.status} ${(await res.text()).slice(0, 200)}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}

/**
 * ワーカーのループから毎回呼ぶ。送るべきなら送り、状態を保存する。
 * 送れなかったときは状態を進めない（次の周回でもう一度試す）。戻り値はログ用の文字列か null
 */
export async function checkAndAlert(log = console.log) {
  const now = Date.now()
  const kind = decide(health, now)
  if (kind) {
    const m = buildMail(kind, health, now)
    const r = await sendAdminMail(m.subject, m.text)
    if (r.ok) health = markSent(health, kind, now)
    log(`AI停止の監視: ${m.subject} → ${r.ok ? `送信 ${MAIL_TO}` : `送信失敗 ${r.reason}`}`)
  }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(health)) } catch { /* 保存できなくても監視は続ける */ }
  return kind
}

export const _peekHealth = () => health
