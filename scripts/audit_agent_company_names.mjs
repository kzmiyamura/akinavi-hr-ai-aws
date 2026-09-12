#!/usr/bin/env node
/**
 * agent_companies の会社名を、いまの検閲（inbound-email の isPlausibleCompanyName）と
 * 後処理（sanitizeFromCompany）に通し直して、通らない名前を洗い出す。
 *
 *   node scripts/audit_agent_company_names.mjs <会社名一覧json>
 *
 * 入力は `[{domain, name}]` か `supabase db query` の出力そのまま。
 * 取り込み時の検閲を強くしても**すでに入っている行は直らない**ので、
 * 直す対象を出すためのもの。判定はレプリカを作らず index.ts から切り出す。
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../supabase/functions/inbound-email/index.ts',
)

function loadGate() {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name) => {
    const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[gimsuy]*)\\r?\\n`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return m[1]
  }
  const body = src.match(/function isPlausibleCompanyName\(name: string\): boolean \{([\s\S]*?)\n\}/)
  if (!body) throw new Error('isPlausibleCompanyName を index.ts から取り出せませんでした')
  const code = `
    const COMPANY_NG_SENTENCE = ${pick('COMPANY_NG_SENTENCE')};
    const COMPANY_NG_HEADCOUNT = ${pick('COMPANY_NG_HEADCOUNT')};
    const COMPANY_NG_PERSON = ${pick('COMPANY_NG_PERSON')};
    const COMPANY_NG_DATE = ${pick('COMPANY_NG_DATE')};
    const COMPANY_NG_ROLE_ONLY = ${pick('COMPANY_NG_ROLE_ONLY')};
    const COMPANY_NG_GENERIC = ${pick('COMPANY_NG_GENERIC')};
    const COMPANY_NG_RANDOM = ${pick('COMPANY_NG_RANDOM')};
    const COMPANY_HAS_CORP = ${pick('COMPANY_HAS_CORP')};
    const COMPANY_CORP_STRIP = ${pick('COMPANY_CORP_STRIP')};
    const COMPANY_NG_DEPT_ONLY = ${pick('COMPANY_NG_DEPT_ONLY')};
    const COMPANY_NG_NO_IDENT = ${pick('COMPANY_NG_NO_IDENT')};
    return function (name) {${body[1].replace(/: string/g, '')}\n}
  `
  return new Function(code)()
}

const inPath = process.argv[2]
if (!inPath) {
  console.error('使い方: node scripts/audit_agent_company_names.mjs <会社名一覧json>')
  process.exit(1)
}
const text = readFileSync(inPath, 'utf8')
const cands = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0)
const json = JSON.parse(text.slice(cands.length > 0 ? Math.min(...cands) : 0))
const list = Array.isArray(json) ? json : (json.rows?.[0]?.list ?? json.rows ?? [])

const isPlausible = loadGate()
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/
const HEAD_DECOR = /^[・･\-‐−ー–—━─―＝=■□●○◆◇▼▲★☆*＊#＃:：、。\s　]/

const bad = []
for (const c of list) {
  const reasons = []
  if (!isPlausible(c.name)) reasons.push('検閲を通らない')
  if (ZERO_WIDTH.test(c.name)) reasons.push('ゼロ幅文字')
  if (HEAD_DECOR.test(c.name)) reasons.push('先頭に記号')
  if (/[（(【「]/.test(c.name)) reasons.push('括弧が残っている')
  if (c.name !== c.name.trim()) reasons.push('前後に空白')
  if (reasons.length > 0) bad.push({ ...c, reasons })
}

console.log(`会社名あり ${list.length} 社 / いまの基準で怪しい ${bad.length} 社\n`)
for (const b of bad) console.log(`  ${b.name}\t${b.domain}\t${b.reasons.join('・')}`)
