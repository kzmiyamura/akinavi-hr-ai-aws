#!/usr/bin/env node
/**
 * 【実験】役割の判定を「本文まるごと渡し」から「計算値（特徴量）渡し」に変えたら
 *        精度とトークンはどうなるか。**ローカル控えだけを使い、本番は一切触らない。**
 *
 * ユーザー提案（2026-09-19）:
 *   「llmに文字渡しじゃなく計算値渡しにしたら、より精度高く、よりトークンを減らした
 *     ai校正ができるのでは？」→ まず役割で試す。
 *
 * 測った前提（校正済み299人・prod 実測）:
 *   AI が実際に書き換えたのは projects 64.2% / skillYears 64.2% / experience_years 54.8% で、
 *   本文由来は name 13.7% / age 12.0% と少ない。**regex が出した答えをAIが導出し直している**。
 *
 * 比較する2本:
 *   A 現行   … ROLE_RULES + 本文まるごと（最大6000字）
 *   B 特徴量 … ROLE_RULES + regex が出した役割候補（根拠・到達レベル・スコア付き）
 *              + その根拠が出た前後だけの抜粋
 *
 * ⚠ B には **アンカリング**の危険がある。regex の答えを見せると、モデルはそれに
 *   同意する方向に倒れ、「regex が間違えた役割」を直せなくなる。
 *   なので一致率だけを見ても意味が無い。**A と B が食い違った件を必ず目視する**ため、
 *   食い違いは全部出力する。
 *
 *   node scripts/experiment_role_features.mjs [--n 10] [--days 2] [--dry]
 */
import fs from 'fs'
import path from 'path'
import { extractFromProse } from './_extractors.gen.mjs'
import { ROLE_RULES } from './llm_extract/prompts.mjs'
import { callModel } from './llm_extract/caller.mjs'
import { trimBodyForLlm } from './llm_extract/shadow_worker_lib.mjs'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const N = Number(argOf('--n', '10'))
const DAYS = Number(argOf('--days', '2'))
const DRY = args.includes('--dry')          // AIを呼ばずにプロンプトの大きさだけ見る
const SRC = 'supabase/functions/inbound-email/index.ts'

// ── 控えの読み取り（他の計測スクリプトと同じ扱い） ─────────────────────────
const decodeEntities = (t) => String(t)
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const stripHtml = (h) => h
  .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, '')
const bodyOf = (m) => {
  const raw = typeof m.body === 'string' ? m.body : (m.body?.content ?? m.bodyPreview ?? '')
  const isHtml = typeof m.body === 'string'
    ? /<(?:html|body|div|br|p)\b/i.test(raw)
    : (m.body?.contentType ?? '').toLowerCase() === 'html'
  return decodeEntities(isHtml ? stripHtml(raw) : raw)
}

/** 人材メールだけを対象にする（役割抽出は人材メールでしか走らない）。本番の門番を切り出す */
function loadCandidateGate() {
  const src = fs.readFileSync(SRC, 'utf8')
  const m = src.match(/function bodyHasCandidateProfile\(([\s\S]*?)\n\}/)
  if (!m) throw new Error('bodyHasCandidateProfile が見つかりません')
  return new Function(`function bodyHasCandidateProfile(${m[1]}\n}\nreturn bodyHasCandidateProfile`
    .replace(/:\s*string/g, '').replace(/:\s*boolean/g, ''))()
}
const isCandidateMail = loadCandidateGate()

const since = new Date(Date.now() - DAYS * 86400_000)
const days = fs.readdirSync(MAIL_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => new Date(`${d.name}T23:59:59Z`) >= since)
  .map((d) => d.name).sort()

/** 役割が絡む人材メールを N 件集める */
const samples = []
outer: for (const day of days) {
  for (const m of fs.readdirSync(path.join(MAIL_ROOT, day), { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const jf = path.join(MAIL_ROOT, day, m.name, 'message.json')
    if (!fs.existsSync(jf)) continue
    let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const body = bodyOf(j)
    if (!isCandidateMail(body)) continue
    const subject = String(j.subject ?? '')
    const text = `${subject}\n${body}`
    const prose = extractFromProse(text, '')
    // regex が1つ以上役割を出したものだけ。0件だと比較にならない
    if (!prose.roles?.length) continue
    samples.push({ subject, body, text, prose })
    if (samples.length >= N) break outer
  }
}
if (!samples.length) { console.log('対象メールが見つかりません'); process.exit(1) }

// ── プロンプトの組み立て ─────────────────────────────────────────────────
const OUT_SHAPE = `\n出力は次のJSONのみ（説明文・コードフェンス禁止）:\n{"mainRole":null,"subRoles":[]}\n`

/** A: 現行。本文をそのまま渡す */
const promptA = (s) =>
  `あなたはSES営業メールの読み取り係です。本文から候補者の役割を判断してください。\n${ROLE_RULES}${OUT_SHAPE}\n--- 以下メール本文 ---\n${trimBodyForLlm(s.text)}`

/** 根拠が出た前後だけを抜く。全文を渡さずに判断材料だけ残す */
function evidenceSnippets(text, roles, width = 90) {
  const out = []
  for (const r of roles) {
    // 役割名そのもの、または語幹で本文を探す（regex 本体は持ち出さず、表示名で十分）
    const key = r.replace(/エンジニア$|マネージャー$|リーダー$/, '')
    const i = text.indexOf(key)
    if (i < 0) continue
    out.push(`[${r}] …${text.slice(Math.max(0, i - width), i + width).replace(/\s+/g, ' ')}…`)
  }
  return out.join('\n')
}

/** B: 特徴量。regex の計算結果＋根拠の抜粋だけを渡す */
const promptB = (s) => {
  const p = s.prose
  const lines = p.roles.map((r) => {
    const sc = p.roleScores?.[r]
    const lv = p.roleLevels?.[r]
    const ev = p.roleEvidence?.[r]
    return `  - ${r}（スコア${sc ?? '-'}${lv ? ` / 到達レベル${lv}` : ''}${ev ? ` / 根拠は「${ev}」どまり` : ''}）`
  }).join('\n')
  return `あなたはSES営業の役割判定の検査係です。
機械抽出が下の候補を出しました。**候補の取捨選択と主役割の決定だけ**を行ってください。
候補に無い役割を新しく足さないでください。
${ROLE_RULES}

■ 機械抽出が出した役割候補
${lines}

■ 根拠が出た箇所（前後${90}字）
${evidenceSnippets(s.text, p.roles)}

■ 件名
${s.subject}
${OUT_SHAPE}`
}

// ── 実行 ─────────────────────────────────────────────────────────────────
const sum = { a: 0, b: 0 }
console.log(`対象: ${samples.length}件（${days.join(', ')}）${DRY ? ' ※--dry: AIは呼ばない' : ''}\n`)

const results = []
for (const [i, s] of samples.entries()) {
  const pa = promptA(s), pb = promptB(s)
  sum.a += pa.length; sum.b += pb.length
  if (DRY) { console.log(`${String(i + 1).padStart(2)}. A ${String(pa.length).padStart(6)}字 / B ${String(pb.length).padStart(5)}字  ${s.subject.slice(0, 50)}`); continue }
  let ra = null, rb = null
  try { ra = (await callModel('haiku', pa)).data } catch (e) { ra = { error: String(e.message).slice(0, 60) } }
  try { rb = (await callModel('haiku', pb)).data } catch (e) { rb = { error: String(e.message).slice(0, 60) } }
  results.push({ s, pa, pb, ra, rb })
  const same = ra?.mainRole === rb?.mainRole
  console.log(`${String(i + 1).padStart(2)}. ${same ? '一致' : '★相違'}  A=${ra?.mainRole ?? 'null'} / B=${rb?.mainRole ?? 'null'}  (${pa.length}字→${pb.length}字)`)
}

console.log(`\n■ プロンプトの大きさ`)
console.log(`  A 現行  : 平均 ${Math.round(sum.a / samples.length).toLocaleString()}字`)
console.log(`  B 特徴量: 平均 ${Math.round(sum.b / samples.length).toLocaleString()}字  (${((1 - sum.b / sum.a) * 100).toFixed(1)}%減)`)

if (!DRY) {
  const diff = results.filter((r) => r.ra?.mainRole !== r.rb?.mainRole)
  console.log(`\n■ 主役割の一致: ${results.length - diff.length}/${results.length}`)
  console.log(`\n■ 食い違った件（全部出す。どちらが正しいかは人が見る）`)
  for (const d of diff) {
    console.log(`\n  件名: ${d.s.subject.slice(0, 78)}`)
    console.log(`    regex候補 : ${d.s.prose.roles.join(', ')}`)
    console.log(`    A(本文)   : main=${d.ra?.mainRole ?? 'null'} sub=${(d.ra?.subRoles ?? []).join(',')}`)
    console.log(`    B(特徴量) : main=${d.rb?.mainRole ?? 'null'} sub=${(d.rb?.subRoles ?? []).join(',')}`)
  }
}
