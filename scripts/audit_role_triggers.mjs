#!/usr/bin/env node
// =============================================================================
// 役割抽出の「何が引き金になったか」をローカル控えのメールで数える
// =============================================================================
// 使い方:
//   node scripts/audit_role_triggers.mjs [--dir D:/akinavi-archive/mail] [--role PL] [--top 12]
//
// なぜ要るか:
//   prod の役割分布が プロジェクトリーダー51% / 運用保守67% と明らかに多い。
//   ただし「多い」だけでは誤りと言えない。**どの語が引き金になったか**を数えないと、
//   正しく拾っているのか、営業文の断片を拾っているのかが分からない。
//   ヘルプデスクでは「問い合わせ対応」だけで63%が付いていた（2026-09-15 実測）。
//
// egress ゼロ:
//   本番を引かない。D:\akinavi-archive\mail のメール原本（7,000通超）を読む。
//
// レプリカを作らない:
//   ROLE_DEFS を supabase/functions/inbound-email/index.ts から**テキストとして読み出し**、
//   トップレベルの `|` で選択肢に割って、どの選択肢が当たったかを見る。
//   手書きで regex を写すと本番と食い違う（scripts/test_extraction.mjs の教訓）。
// =============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const MAIL_DIR = argOf('--dir', process.env.AKINAVI_ARCHIVE_DIR
  ? join(process.env.AKINAVI_ARCHIVE_DIR, 'mail')
  : 'D:/akinavi-archive/mail')
const ONLY_ROLE = argOf('--role', null)
const TOP = Number(argOf('--top', 12))
const SRC = resolve(process.cwd(), 'supabase/functions/inbound-email/index.ts')

// ── ROLE_DEFS を index.ts から取り出す ──────────────────────────────────────
function loadRoleDefs() {
  const src = readFileSync(SRC, 'utf8')
  const start = src.indexOf('const ROLE_DEFS')
  if (start < 0) throw new Error('ROLE_DEFS が index.ts に見つかりません')
  const block = src.slice(start, src.indexOf('\n  ]', start))
  const defs = []
  // `{ re: /.../, label: '...' },` を1行1件で拾う。行コメントは無視される
  for (const line of block.split('\n')) {
    const m = line.match(/\{\s*re:\s*\/(.*)\/([a-z]*),\s*label:\s*'([^']+)'\s*\}/)
    if (m) defs.push({ source: m[1], flags: m[2], label: m[3] })
  }
  if (!defs.length) throw new Error('ROLE_DEFS の行を1つも解釈できませんでした')
  return defs
}

/** トップレベルの `|` で割る。括弧内・文字クラス内・エスケープ直後は区切らない */
function splitAlternatives(source) {
  const out = []
  let depth = 0, inClass = false, cur = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') { cur += ch + (source[i + 1] ?? ''); i++; continue }
    if (inClass) { cur += ch; if (ch === ']') inClass = false; continue }
    if (ch === '[') { inClass = true; cur += ch; continue }
    if (ch === '(') { depth++; cur += ch; continue }
    if (ch === ')') { depth--; cur += ch; continue }
    if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.filter(s => s.length)
}

const DEFS = loadRoleDefs().map(d => ({
  label: d.label,
  whole: new RegExp(d.source, d.flags.includes('g') ? d.flags : d.flags + 'g'),
  alts: splitAlternatives(d.source).map(a => ({
    source: a,
    re: new RegExp(a, 'g'),
  })),
}))

// ── メール本文を歩く ────────────────────────────────────────────────────────
function* walkMails(root) {
  if (!existsSync(root)) throw new Error(`控えが見つかりません: ${root}`)
  for (const day of readdirSync(root, { withFileTypes: true })) {
    if (!day.isDirectory()) continue
    const dayDir = join(root, day.name)
    for (const mail of readdirSync(dayDir, { withFileTypes: true })) {
      if (!mail.isDirectory()) continue
      const jsonPath = join(dayDir, mail.name, 'message.json')
      if (!existsSync(jsonPath)) continue
      try {
        // PowerShell が BOM 付きで書くので剥がす
        const raw = readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '')
        const m = JSON.parse(raw)
        yield { day: day.name, subject: m.subject ?? '', body: m.body ?? '' }
      } catch { /* 壊れた1通で全体を止めない */ }
    }
  }
}

// ── 集計 ────────────────────────────────────────────────────────────────────
/** 役割 → { mails, alts: Map<選択肢, {count, samples:Set}>, onlyAlt: Map<選択肢, count> } */
const stat = new Map()
let mailCount = 0

for (const mail of walkMails(MAIL_DIR)) {
  mailCount++
  const text = mail.subject + '\n' + mail.body
  for (const def of DEFS) {
    if (ONLY_ROLE && !def.label.includes(ONLY_ROLE)) continue
    def.whole.lastIndex = 0
    if (!def.whole.test(text)) continue

    if (!stat.has(def.label)) {
      stat.set(def.label, { mails: 0, alts: new Map(), onlyAlt: new Map() })
    }
    const s = stat.get(def.label)
    s.mails++

    const hit = []
    for (const alt of def.alts) {
      alt.re.lastIndex = 0
      const m = alt.re.exec(text)
      if (!m) continue
      hit.push(alt.source)
      if (!s.alts.has(alt.source)) s.alts.set(alt.source, { count: 0, samples: new Set() })
      const a = s.alts.get(alt.source)
      a.count++
      if (a.samples.size < 3) {
        const from = Math.max(0, m.index - 16)
        a.samples.add(text.slice(from, m.index + m[0].length + 16).replace(/\s+/g, ' ').trim())
      }
    }
    // その選択肢**だけ**が根拠だったケース（＝それを外すと役割が消える）
    if (hit.length === 1) {
      s.onlyAlt.set(hit[0], (s.onlyAlt.get(hit[0]) ?? 0) + 1)
    }
  }
}

// ── 出力 ────────────────────────────────────────────────────────────────────
console.log(`\n控え: ${MAIL_DIR}`)
console.log(`メール ${mailCount} 通を検査\n`)

const rows = [...stat.entries()].sort((a, b) => b[1].mails - a[1].mails)
for (const [label, s] of rows) {
  const pct = ((s.mails / mailCount) * 100).toFixed(1)
  console.log(`\n══ ${label} — ${s.mails}通 (${pct}%) ══`)
  const alts = [...s.alts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, TOP)
  for (const [src, a] of alts) {
    const only = s.onlyAlt.get(src) ?? 0
    const onlyPct = s.mails ? ((only / s.mails) * 100).toFixed(0) : '0'
    console.log(`  ${String(a.count).padStart(5)}通  唯一の根拠 ${String(only).padStart(5)}通(${onlyPct.padStart(3)}%)  /${src}/`)
    for (const sample of a.samples) console.log(`         例: …${sample}…`)
  }
}
console.log('')
