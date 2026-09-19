#!/usr/bin/env node
/**
 * 役割の判定語を広げたとき、**何人に付くようになるか**を実データで測る。
 *
 * CLAUDE.md の鉄則「分類は実データで分かれる分だけ。消す/足す前に影響人数を測る」に従う。
 * 広げた語に当たるが、元の語には当たらないメールを数える。増えすぎるなら語が広すぎる。
 *
 * 判定語は index.ts の ROLE_DEFS から**その場で切り出す**（レプリカを書かない）。
 * 比較対象の「元の語」は引数で渡す。
 *
 * ローカル控えだけを使う（本番を引かない＝egress ゼロ）。
 *
 *   node scripts/measure_role_widen.mjs --label インフラエンジニア --old "インフラ[　 ]?エンジニア"
 */
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const MAIL_ROOT = argOf('--mail', 'D:\\akinavi-archive\\mail')
const LABEL = argOf('--label', '')
const OLD_SRC = argOf('--old', '')
const SRC = argOf('--src', 'supabase/functions/inbound-email/index.ts')
const SHOW = Number(argOf('--show', '8'))

if (!LABEL || !OLD_SRC) {
  console.error('使い方: node scripts/measure_role_widen.mjs --label <役割名> --old <変更前の正規表現>')
  process.exit(1)
}

/** ROLE_DEFS から、その label の正規表現を取り出す */
function newRegexFor(label) {
  const src = fs.readFileSync(SRC, 'utf8')
  const start = src.indexOf('const ROLE_DEFS')
  if (start < 0) throw new Error('ROLE_DEFS が見つかりません')
  const region = src.slice(start, start + 20000)
  for (const line of region.split('\n')) {
    if (!line.includes(`label: '${label}'`)) continue
    const m = line.match(/re:\s*(\/(?:\\.|\[[^\]]*\]|[^/])+\/[a-z]*)/)
    if (m) return new Function(`return ${m[1]}`)()
  }
  throw new Error(`label='${label}' の判定語を取り出せませんでした`)
}

const NEW_RE = newRegexFor(LABEL)
const OLD_RE = new RegExp(OLD_SRC)

/** 本番の門番 bodyHasCandidateProfile を切り出す。
 *  役割抽出は**人材メールでしか走らない**ので、案件メールを混ぜて数えると影響を見誤る
 *  （最初にこれをやって 1,307通 という過大な数字を出した・2026-09-19）。 */
function loadCandidateGate() {
  const src = fs.readFileSync(SRC, 'utf8')
  const m = src.match(/function bodyHasCandidateProfile\(([\s\S]*?)\n\}/)
  if (!m) return null
  const js = `function bodyHasCandidateProfile(${m[1]}\n}\nreturn bodyHasCandidateProfile`
    .replace(/:\s*string/g, '').replace(/:\s*boolean/g, '')
  return new Function(js)()
}
const isCandidateMail = loadCandidateGate()
if (!isCandidateMail) { console.error('bodyHasCandidateProfile が見つかりません'); process.exit(1) }

const decodeEntities = (t) => String(t)
  .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
const stripHtml = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
const bodyOf = (m) => {
  const raw = typeof m.body === 'string' ? m.body : (m.body?.content ?? m.bodyPreview ?? '')
  const isHtml = typeof m.body === 'string'
    ? /<(?:html|body|div|br|p)\b/i.test(raw)
    : (m.body?.contentType ?? '').toLowerCase() === 'html'
  return decodeEntities(isHtml ? stripHtml(raw) : raw)
}

const days = fs.readdirSync(MAIL_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
  .filter((d) => fs.readdirSync(path.join(MAIL_ROOT, d.name)).length > 100)
  .map((d) => d.name).sort()

let scanned = 0, oldHit = 0, newHit = 0
const gained = []
for (const day of days) {
  const dayDir = path.join(MAIL_ROOT, day)
  for (const m of fs.readdirSync(dayDir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue
    const jf = path.join(dayDir, m.name, 'message.json')
    if (!fs.existsSync(jf)) continue
    let j; try { j = JSON.parse(fs.readFileSync(jf, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    // 本番と同じく「件名 + 本文」を対象にする（regexBodyText は件名を含む）
    const subject = String(j.subject ?? '')
    const body = bodyOf(j)
    // 役割抽出は人材メールでしか走らない。案件メールを混ぜて数えない
    if (!isCandidateMail(body)) continue
    const text = `${subject}\n${body}`
    scanned++
    const o = OLD_RE.test(text), n = NEW_RE.test(text)
    if (o) oldHit++
    if (n) newHit++
    if (n && !o) {
      const hit = text.match(NEW_RE)?.[0] ?? ''
      gained.push({ subject: subject.slice(0, 68), hit })
    }
  }
}

console.log(`役割: ${LABEL}`)
console.log(`変更前: ${NEW_RE}` )
console.log(`対象  : ${days.length}日 / ${scanned}通\n`)
console.log(`変更前に当たる: ${oldHit}通`)
console.log(`変更後に当たる: ${newHit}通`)
console.log(`増える        : ${gained.length}通（全体の ${(gained.length / scanned * 100).toFixed(1)}%）`)

const byHit = new Map()
for (const g of gained) byHit.set(g.hit, (byHit.get(g.hit) ?? 0) + 1)
console.log(`\n■ 増えた分は、どの語に当たったか`)
for (const [h, n] of [...byHit].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}通  ${h}`)
console.log(`\n■ 増えた件名（${SHOW}件）`)
for (const g of gained.slice(0, SHOW)) console.log(`  [${g.hit}] ${g.subject}`)
