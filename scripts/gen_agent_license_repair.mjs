#!/usr/bin/env node
/**
 * reverify_agent_licenses.mjs の結果から、agent_companies を直す SQL を書き出す。
 *
 *   node scripts/gen_agent_license_repair.mjs <出力sql> <reverify結果json> [<結果json> ...]
 *
 * 現在の値との差だけを UPDATE にする。1社1行・直す理由をコメントに残すのは、
 * 本番データの更新をユーザーが読んで確認してから流すため（スクリプトからは書かない）。
 *
 * 入力の各行は reverify_agent_licenses.mjs の出力形式:
 *   { domain, name, status, haken, shokai, detailUrl, matchedKey, ambiguous }
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [outPath, ...inPaths] = process.argv.slice(2)
if (!outPath || inPaths.length === 0) {
  console.error('使い方: node scripts/gen_agent_license_repair.mjs <出力sql> <reverify結果json> [...]')
  process.exit(1)
}

const rows = inPaths.flatMap((p) => JSON.parse(readFileSync(p, 'utf8')))
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`)

const found = rows.filter((r) => r.status === 'haken' || r.status === 'both' || r.status === 'shokai')
const notfound = rows.filter((r) => r.status === 'notfound')
const errored = rows.filter((r) => r.status === 'error')

const lines = [
  '-- agent_companies の免許判定の修復（2026-09-12）',
  '--',
  '-- 直した2つの取り違え:',
  '--   ① 検索キーが半角のままで、サイト側の全角表記（「株式会社ＧＦＤ」）に当たっていなかった',
  '--   ② 引けなかった＝免許なし(none) と記録していた。正しくは照合できず(notfound)',
  '--   ③ 結果ページの先頭の番号を社名照合なしで採っていた（他社の番号が付いていた）',
  '--',
  `-- 再照合 ${rows.length} 社: 免許あり ${found.length} 社 / 照合できず ${notfound.length} 社` +
    (errored.length ? ` / エラー ${errored.length} 社` : ''),
  '',
  'begin;',
  '',
  '-- ① 免許が確認できた会社（社名が完全一致した行の番号だけを採用）',
]

for (const r of found) {
  lines.push(
    `update agent_companies set license_status = ${q(r.status)}, haken_number = ${q(r.haken)}, ` +
      `shokai_number = ${q(r.shokai)}, haken_detail_url = ${q(r.detailUrl)}, ` +
      `verified_at = now(), verified_by = 'reverify-2026-09-12' ` +
      `where domain = ${q(r.domain)};` +
      `  -- ${r.name}${r.matchedKey && r.matchedKey !== r.name ? ` ←「${r.matchedKey}」で一致` : ''}`,
  )
}

lines.push(
  '',
  '-- ② 社名が一致する事業主を見つけられなかった会社。',
  '--    「免許なし」とは言い切らず「照合できず」にする。絞り込み上の扱い（派遣案件に',
  '--    出さない）は none と同じで、変えるのは言い切るかどうかだけ。',
  '--    許可番号も外す（他社の番号が付いていることがあるため）。',
  `update agent_companies set license_status = 'notfound', haken_number = null, ` +
    `shokai_number = null, haken_detail_url = null, verified_at = now(), ` +
    `verified_by = 'reverify-2026-09-12'\n where domain in (`,
)
lines.push(
  notfound
    .map((r, i) => {
      const why = r.ambiguous ? `同名が複数 ${r.ambiguous.join(',')}` : ''
      return `   ${q(r.domain)}${i < notfound.length - 1 ? ',' : ''}  -- ${r.name}${why ? ` / ${why}` : ''}`
    })
    .join('\n'),
)
lines.push(' );')

if (errored.length > 0) {
  lines.push('', '-- 通信エラーで判定できなかった会社（触らない）')
  for (const r of errored) lines.push(`--   ${r.domain}  ${r.name}`)
}

lines.push('', 'commit;', '')
writeFileSync(outPath, lines.join('\n'), 'utf8')

console.log(`書き出し: ${outPath}`)
console.log(`  免許あり ${found.length} 社 / 照合できず ${notfound.length} 社 / エラー ${errored.length} 社`)
console.log(`  全角変換で初めて引けた: ${found.filter((r) => r.matchedKey !== r.name).length} 社`)
console.log(`  同名が複数あって特定できなかった: ${notfound.filter((r) => r.ambiguous).length} 社`)
