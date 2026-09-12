#!/usr/bin/env node
/**
 * agent_companies を厚労省サイトに引き直し、結果を JSON に落とす（DB は書き換えない）。
 *
 *   node scripts/reverify_agent_licenses.mjs <入力json> <出力json> [--limit N] [--gap 1500]
 *
 * 入力は `[{ "domain": "...", "name": "..." }, ...]`、または
 * `supabase db query` の出力（`{ rows: [{ list: [...] }] }`）をそのまま渡してもよい。
 *
 * 出力は1社1件で、採用した検索キー（matchedKey）と試したキー（tried）も残す。
 * 「どの書き方で引けたか」が分からないと、引けなかった社を後から詰められないため。
 *
 * 途中で落ちても再開できるよう、1件ごとに出力ファイルへ書き戻す。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { lookupCompany } from './lib/mhlw.mjs'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback
}
if (positional.length < 2) {
  console.error('使い方: node scripts/reverify_agent_licenses.mjs <入力json> <出力json> [--limit N] [--gap 1500]')
  process.exit(1)
}
const [inPath, outPath] = positional
const limit = flag('limit', Infinity)
const gapMs = flag('gap', 1500)

function loadInput(path) {
  const text = readFileSync(path, 'utf8')
  // supabase db query は前に「Initialising login role...」を出すので、
  // 最初の { か [ のうち早い方から読む（素の配列を渡してもよい）
  const cands = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0)
  const json = JSON.parse(text.slice(cands.length > 0 ? Math.min(...cands) : 0))
  if (Array.isArray(json)) return json
  const list = json.rows?.[0]?.list ?? json.list ?? json.rows
  if (!Array.isArray(list)) throw new Error('入力から会社一覧を取り出せない')
  return list
}

const companies = loadInput(inPath).filter((c) => c.name)
const done = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : []
const doneDomains = new Set(done.map((r) => r.domain))
const todo = companies.filter((c) => !doneDomains.has(c.domain)).slice(0, limit)

console.log(`対象 ${companies.length} 社 / 済 ${done.length} 社 / 今回 ${todo.length} 社`)

const results = [...done]
for (const [i, c] of todo.entries()) {
  try {
    const r = await lookupCompany(c.name, { gapMs })
    results.push({
      domain: c.domain,
      name: c.name,
      status: r.status,
      haken: r.haken[0] ?? null,
      shokai: r.shokai[0] ?? null,
      officialName: r.names[0] ?? null,
      detailUrl: r.detailUrl,
      matchedKey: r.matchedKey,
      tried: r.tried,
      // 番号は取れたが社名が一致しなかった行。こちらの社名が壊れているのか、
      // 本当に登録が無いのかを、あとから引き直さずに切り分けるため残す
      nearMiss: (r.nearMiss ?? []).slice(0, 5).map((e) => `${e.number} ${e.name}`),
      // 社名は一致したが同名の事業主が複数あって特定できなかった番号
      ambiguous: r.ambiguous ?? null,
    })
    console.log(
      `[${i + 1}/${todo.length}] ${c.name} → ${r.status}` +
        (r.matchedKey && r.matchedKey !== c.name ? `（"${r.matchedKey}" で一致）` : '') +
        (r.ambiguous ? `（同名が複数: ${r.ambiguous.join(',')}）` : ''),
    )
  } catch (e) {
    results.push({ domain: c.domain, name: c.name, status: 'error', error: String(e) })
    console.log(`[${i + 1}/${todo.length}] ${c.name} → ERROR ${String(e)}`)
  }
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8')
}

const tally = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {})
console.log('\n集計:', JSON.stringify(tally))
const recovered = results.filter((r) => r.status === 'haken' || r.status === 'both' || r.status === 'shokai')
console.log(`免許が見つかった: ${recovered.length} 社`)
console.log(`うち全角変換で初めて引けた: ${recovered.filter((r) => r.matchedKey !== r.name).length} 社`)
