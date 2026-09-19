#!/usr/bin/env node
/**
 * 届いた人材メールが「どこで捨てられたか」を、本番の判定関数そのままで再現する。
 *
 * 背景（2026-09-19 実測）: ローカル控えの 5日分で、件名が人材のメール 9,190通に対し
 * 登録された人材は 1,244人。会社ごと丸ごとゼロの送信元が 162件・2,808通あった
 * （skill-c.co.jp 414通/0人、flexi-inc.com 340通/0人 など）。
 *
 * 振り分けの実体は poll-email の preFilterEmail:
 *   skip      … 捨てる（営業メール等）
 *   project   … 案件として扱う → inbound_project_enabled=false なので**保存されず消える**
 *   candidate … 人材として取り込む
 *   unknown   … Gemini のメール種別分類に回す（email_use_ai_classification=true）
 *
 * レプリカは作らない。**本番に出す index.ts から関数を切り出して**当てる
 * （nameLabelGate.test.ts と同じ流儀）。判定がズレたら意味が無いため。
 *
 * 本番を一切引かない（egress ゼロ）。
 *
 *   node scripts/replay_prefilter.mjs [--top 30] [--dump project:30]
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const DB_ROOT = argOf('--db', 'D:\\akinavi-archive\\db\\candidates')
const SRC = argOf('--src', 'supabase/functions/poll-email/index.ts')
const TOP = Number(argOf('--top', '30'))
const DUMP = argOf('--dump', '')   // 例: project:30 … その判定になった件名を30件出す
/**
 * 送信元ごとの登録人数（本番の実数・scripts/sql/reg_by_sender.sql の出力）。
 *
 * ⚠ 2026-09-19 の教訓: ローカルDB控え（db\candidates\*.jsonl）は本番に追いついておらず、
 * 9/18 は本番1,452人に対し控え222人しか無かった。控えの欠けを取りこぼしと読むと桁違いの誤報になる。
 * --reg を渡すと「1人も登録していない送信元」だけに絞って集計する。
 * その送信元のメールは**全通が取りこぼし**なので、件名照合の誤差が入らない。
 */
const REG_JSON = argOf('--reg', '')

// ── 本番の判定を切り出す ───────────────────────────────────────────────
/** どのルールが撃ったかを名前付きで返せるよう、定数も一緒に取り出す */
function loadPreFilter(withConstants = false) {
  const src = fs.readFileSync(SRC, 'utf8')
  const start = src.indexOf('const SKIP_SUBJECT_PATTERNS = [')
  const endMark = '\nfunction preFilterEmail('
  const endStart = src.indexOf(endMark)
  if (start < 0 || endStart < 0) throw new Error('poll-email から判定部を取り出せませんでした')
  // preFilterEmail の本体末尾（最初の行頭 "}"）まで
  const after = src.slice(endStart + 1)
  const bodyEnd = after.indexOf('\n}\n')
  if (bodyEnd < 0) throw new Error('preFilterEmail の終端が見つかりませんでした')
  const region = src.slice(start, endStart + 1 + bodyEnd + 3)

  const js = region
    .replace(/:\s*'skip'\s*\|\s*'candidate'\s*\|\s*'project'\s*\|\s*'unknown'/g, '')
    .replace(/:\s*GraphMessage/g, '')
    .replace(/:\s*string(\[\])?/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/\bexport\s+/g, '')
  return new Function(`${js}\nreturn { preFilterEmail, isCandidateBySubject, isProjectByRuleBase,
    SKIP_SUBJECT_PATTERNS, SKIP_BODY_PATTERNS, PROJECT_SUBJECT_PATTERNS, PROJECT_BODY_PATTERNS,
    HARD_PROJECT_SUBJECT, HR_SUBJECT_PATTERNS }`)()
}
const F = loadPreFilter()
const { preFilterEmail } = F

/**
 * その判定を下した「具体的なルール」を返す。
 * 判定の内訳が分かっても、撃った語が分からないと直せない。
 * preFilterEmail と同じ順序で当てる（順序がズレると別の語のせいにしてしまう）。
 */
function whichRule(verdict, subject, plainBody, plainBody500) {
  if (verdict === 'skip') {
    const s = F.SKIP_SUBJECT_PATTERNS.find((p) => p.test(subject))
    if (s) return `件名:${s.source.slice(0, 40)}`
    const b = F.SKIP_BODY_PATTERNS.find((p) => p.test(plainBody))
    if (b) return `本文:${b.source.slice(0, 40)}`
    return '(不明)'
  }
  if (verdict === 'project') {
    if (/エンド直|直案件|直\s*案件|合う人材|ご紹介をお待ち|エンドユーザー.*直/.test(subject)) return '件名:エンド直/直案件系'
    const s = F.PROJECT_SUBJECT_PATTERNS.find((p) => p.test(subject))
    if (s) return `件名:${s.source.slice(0, 40)}`
    const b = F.PROJECT_BODY_PATTERNS.find((p) => p.test(plainBody500))
    if (b) return `本文:${b.source.slice(0, 40)}`
    if (F.HR_SUBJECT_PATTERNS.some((p) => p.test(subject))) return '件名:HR判定だが案件語あり(案件|要件|募集|参画|依頼|発注|プロジェクト)'
    return '(不明)'
  }
  return ''
}

// ── 控えを読む ───────────────────────────────────────────────────────
const norm = (s) => String(s ?? '').replace(/[\s　]/g, '').toLowerCase()
const addrOf = (f) => (typeof f === 'string' ? f : (f?.emailAddress?.address ?? '')).toLowerCase().trim()
/** 控えの body は2形（outlook_export=素の文字列 / Graph={contentType,content}）。
 *  preFilterEmail は email.body?.content を読むので必ず揃えてから渡す。
 *  ここを揃えずに渡すと全部「本文なし」になり、判定が丸ごと嘘になる */
const bodyOf = (m) => (typeof m.body === 'string' ? m.body : (m.body?.content ?? m.bodyPreview ?? ''))

const mailDays = fs.readdirSync(MAIL_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name)
const days = mailDays.filter((d) => fs.existsSync(path.join(DB_ROOT, `${d}.jsonl`)))
  .filter((d) => fs.readdirSync(path.join(MAIL_ROOT, d)).length > 100).sort()

/** 登録された人材: from+件名 → 人数 */
const registered = new Map()
let dbPeople = 0
for (const day of days) {
  for (const l of fs.readFileSync(path.join(DB_ROOT, `${day}.jsonl`), 'utf8').split('\n')) {
    if (!l) continue
    let p; try { p = JSON.parse(l) } catch { continue }
    dbPeople++
    const k = `${String(p.rp_from ?? '').toLowerCase().trim()}｜${norm(p.rp_subject)}`
    registered.set(k, (registered.get(k) ?? 0) + 1)
  }
}

// ── 全メールに判定を当てる ───────────────────────────────────────────
const PROJECT_RE = /案件|募集|求人|人員募集|要員募集|お仕事|ご依頼|PJ情報|プロジェクト情報/
const CAND_RE = /人材|要員|技術者|エンジニア|ご紹介|紹介|スキルシート|経歴書|フリーランス|待機|社員/
const subjClass = (s) => (PROJECT_RE.test(s) ? '案件' : CAND_RE.test(s) ? '人材' : 'その他')

const verdictCount = new Map()      // 判定 → {mails, regMails, people}
const bySender = new Map()          // 送信元 → 判定内訳
const dumped = []
const [dumpKind, dumpNRaw] = DUMP.split(':')
const dumpN = Number(dumpNRaw ?? 20)

/** 重複判定の再現（from|件名|本文先頭200字・12時間） */
const seenHash = new Map()
let total = 0, dupCount = 0
const rows = []

for (const day of days) {
  const dayDir = path.join(MAIL_ROOT, day)
  for (const m of fs.readdirSync(dayDir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const jf = path.join(dayDir, m.name, 'message.json')
    if (!fs.existsSync(jf)) continue
    let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    const subject = String(j.subject ?? '')
    const from = addrOf(j.from)
    const body = bodyOf(j)
    const received = new Date(j.receivedTime ?? j.receivedDateTime ?? `${day}T00:00:00Z`).getTime()
    total++

    const verdict = preFilterEmail({ subject, body: { content: body } }, true)
    const k = `${from}｜${norm(subject)}`
    const people = registered.get(k) ?? 0

    // 重複判定（本番と同じ材料。先に来たものを残す）
    const h = crypto.createHash('sha256')
      .update(`${from}|${subject}|${body.slice(0, 200)}`).digest('hex').slice(0, 24)
    const prev = seenHash.get(h)
    const isDup = prev != null && received - prev < 12 * 3600 * 1000
    if (!isDup) seenHash.set(h, received)
    if (isDup) dupCount++

    // 本文が「人の履歴」の体裁か。件名より強い証拠になる。
    // ai_logs は PROJECT_INBOUND_DISABLED の raw_body を記録していない（7,546件すべて null）ので、
    // 案件扱いで消えたメールの中身は**この控えでしか**数えられない。
    const hasNameLabel = /(氏\s*名|お名前|【名\s*前】|【氏\s*名】|要員番号|イニシャル)[\s　]*[：:】]/.test(body)
    const hasPersonAttr = /(\d{2}\s*歳|年\s*齢[\s　]*[：:]|単\s*価[\s　]*[：:]|最寄[\s　]*り?駅)/.test(body)
    // 案件メールの募集条件（「45歳まで」等）を人の年齢と取り違えないための除外
    const isAgeRequirement = /\d{2}\s*歳\s*(位|くらい|程度|前後)?\s*(まで|迄|以下|未満|以上)/.test(body)
    const bodyLooksCandidate = hasNameLabel && hasPersonAttr && !isAgeRequirement
    const plain = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000)
    const rule = whichRule(verdict, subject, plain, plain.slice(0, 500))
    rows.push({ day, from, subject, verdict, people, isDup, cls: subjClass(subject), bodyLooksCandidate, rule })
  }
}

// ── 集計 ─────────────────────────────────────────────────────────────
const candMails = rows.filter((r) => r.cls === '人材')
const bump = (map, key, r) => {
  if (!map.has(key)) map.set(key, { mails: 0, dup: 0, reg: 0, people: 0 })
  const e = map.get(key)
  e.mails++; if (r.isDup) e.dup++; if (r.people > 0) { e.reg++; e.people += r.people }
}
for (const r of candMails) bump(verdictCount, r.verdict, r)

console.log(`対象: ${days.length}日 (${days[0]} 〜 ${days[days.length - 1]}) / メール ${total}通 / DB人材 ${dbPeople}人`)
console.log(`件名が人材のメール: ${candMails.length}通\n`)

// ── 照合そのものの信頼性を先に測る ───────────────────────────────────
// 「メールが見つからない＝登録されていない」と書く前に、**逆向き**を確かめる。
// DBに居る人材の側から、その元メールが控えの中に見つかるか。
// ここが低いと、以降の「未登録N通」は単に私の照合が下手なだけになる。
const mailKeys = new Set(rows.map((r) => `${r.from}｜${norm(r.subject)}`))
let dbMatched = 0, dbUnmatched = 0
const unmatchedSample = []
for (const day of days) {
  for (const l of fs.readFileSync(path.join(DB_ROOT, `${day}.jsonl`), 'utf8').split('\n')) {
    if (!l) continue
    let p; try { p = JSON.parse(l) } catch { continue }
    const k = `${String(p.rp_from ?? '').toLowerCase().trim()}｜${norm(p.rp_subject)}`
    if (mailKeys.has(k)) dbMatched++
    else { dbUnmatched++; if (unmatchedSample.length < 5) unmatchedSample.push(`${p.rp_from} / ${String(p.rp_subject ?? '').slice(0, 60)}`) }
  }
}
const matchRate = dbMatched / (dbMatched + dbUnmatched) * 100
console.log(`■ 照合の信頼性（DBの人材 → 元メールが控えにあるか）`)
console.log(`  見つかった ${dbMatched}人 / 見つからない ${dbUnmatched}人 → 一致率 ${matchRate.toFixed(1)}%`)
if (matchRate < 90) {
  console.log(`  ⚠ 一致率が低い。以降の「未登録」は照合漏れを含むので、数字を鵜呑みにしないこと`)
  for (const s of unmatchedSample) console.log(`    見つからなかった例: ${s}`)
}
console.log()
console.log('■ poll-email の振り分け（本番の preFilterEmail をそのまま適用）')
console.log('  判定        通数    12h重複   登録できた通数   登録人数')
for (const [v, e] of [...verdictCount].sort((a, b) => b[1].mails - a[1].mails)) {
  const note = v === 'project' ? '  ← 案件解析OFFなので保存されず消える'
    : v === 'skip' ? '  ← 捨てる'
    : v === 'unknown' ? '  ← Gemini の分類に回る' : ''
  console.log(`  ${v.padEnd(10)}${String(e.mails).padStart(6)}${String(e.dup).padStart(10)}${String(e.reg).padStart(15)}${String(e.people).padStart(11)}${note}`)
}

// ── 1人も登録していない送信元だけを見る（照合の誤差が入らない） ──────────────
if (REG_JSON) {
  const txt = fs.readFileSync(REG_JSON, 'utf8')
  const regRows = JSON.parse(txt.slice(txt.indexOf('{'))).rows
  const hasPeople = new Set(regRows.filter((r) => Number(r.people ?? 0) > 0)
    .map((r) => String(r.from_address ?? '').toLowerCase().trim()))
  const lost = rows.filter((r) => !hasPeople.has(r.from) && r.bodyLooksCandidate)
  const byV2 = new Map()
  for (const r of lost) {
    if (!byV2.has(r.verdict)) byV2.set(r.verdict, { n: 0, dup: 0, senders: new Set() })
    const e = byV2.get(r.verdict); e.n++; if (r.isDup) e.dup++; e.senders.add(r.from)
  }
  console.log('■ 1人も登録していない送信元のメールのうち、本文が「人の履歴」のもの')
  console.log(`  ${lost.length}通 / 送信元 ${new Set(lost.map((r) => r.from)).size}件（本番の登録実数で判定。全通が取りこぼし）`)
  console.log('  判定        通数    12h重複   送信元数')
  for (const [v, e] of [...byV2].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${v.padEnd(10)}${String(e.n).padStart(6)}${String(e.dup).padStart(10)}${String(e.senders.size).padStart(11)}`)
  }

  // 撃ったルールごとに数える。ここが直す対象そのものになる
  for (const v of ['project', 'skip']) {
    const sub = lost.filter((r) => r.verdict === v)
    if (!sub.length) continue
    const byRule = new Map()
    for (const r of sub) {
      if (!byRule.has(r.rule)) byRule.set(r.rule, { n: 0, senders: new Set(), sample: '' })
      const e = byRule.get(r.rule)
      e.n++; e.senders.add(r.from)
      if (!e.sample) e.sample = `${r.from} / ${r.subject.slice(0, 58)}`
    }
    console.log(`\n  ● ${v} にしたルール（${sub.length}通）`)
    for (const [rule, e] of [...byRule].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
      console.log(`    ${String(e.n).padStart(4)}通 ${String(e.senders.size).padStart(3)}社  ${rule}`)
      console.log(`          例: ${e.sample}`)
    }
  }
  console.log()
}

// ── 本文が人の履歴なのに案件・skip にされた数（件名分類に頼らない集計） ──────
// ⚠ この節は「登録できたか」をローカルDB控えとの件名照合で判定している。
//   控えが本番に追いついていないと取りこぼしを過大に数えるので、
//   --reg（本番の実数）を渡したときは出さない。上の節の方が正確。
if (!REG_JSON) {
console.log(`\n■ 本文が「人の履歴」の体裁（氏名ラベル＋年齢/単価/最寄駅）なのにどう判定されたか`)
console.log('  ※件名ではなく本文で数えている。案件メールの募集年齢（45歳までの形）は除外済み')
const bodyCand = rows.filter((r) => r.bodyLooksCandidate)
const byV = new Map()
for (const r of bodyCand) {
  if (!byV.has(r.verdict)) byV.set(r.verdict, { n: 0, dup: 0, reg: 0 })
  const e = byV.get(r.verdict); e.n++; if (r.isDup) e.dup++; if (r.people > 0) e.reg++
}
console.log(`  対象 ${bodyCand.length}通`)
console.log('  判定        通数    12h重複   登録できた通数   取りこぼし')
for (const [v, e] of [...byV].sort((a, b) => b[1].n - a[1].n)) {
  const lost = e.n - e.reg - e.dup
  console.log(`  ${v.padEnd(10)}${String(e.n).padStart(6)}${String(e.dup).padStart(10)}${String(e.reg).padStart(15)}${String(lost).padStart(13)}`)
}
}

console.log(`\n■ 登録ゼロの送信元は、どの判定で消えているか（上位${TOP}）`)
for (const r of candMails) {
  if (!bySender.has(r.from)) bySender.set(r.from, { mails: 0, people: 0, v: new Map() })
  const e = bySender.get(r.from)
  e.mails++; e.people += r.people
  e.v.set(r.verdict, (e.v.get(r.verdict) ?? 0) + 1)
}
const zero = [...bySender].filter(([, e]) => e.people === 0).sort((a, b) => b[1].mails - a[1].mails)
console.log('  人材通  内訳(判定)                              送信元')
for (const [addr, e] of zero.slice(0, TOP)) {
  const br = [...e.v].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}:${n}`).join(' ')
  console.log(`  ${String(e.mails).padStart(6)}  ${br.padEnd(38)}  ${addr}`)
}

if (dumpKind) {
  console.log(`\n■ 判定が ${dumpKind} になった人材メールの件名（${dumpN}件）`)
  for (const r of candMails.filter((x) => x.verdict === dumpKind && x.people === 0).slice(0, dumpN)) {
    console.log(`  [${r.from}] ${r.subject.slice(0, 80)}`)
  }
}
