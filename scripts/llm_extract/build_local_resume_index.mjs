#!/usr/bin/env node
/**
 * ローカル控えの経歴書に「Storage と同じ内容ハッシュ」で索引を張る（2026-09-26）。
 *
 * 判定の実体は `local_resume.mjs`。ここは手で回すための入口だけ。
 * ワーカーは毎サイクル増分で更新するので、普段これを回す必要はない。
 * 全件の作り直し（索引を消した・控えを別マシンから持ってきた）のときに使う。
 *
 *   node scripts/llm_extract/build_local_resume_index.mjs            # 直近3日ぶんだけ
 *   node scripts/llm_extract/build_local_resume_index.mjs --all      # 全件（1.5GB / 約105秒）
 *   node scripts/llm_extract/build_local_resume_index.mjs --days 14
 */
import { refreshLocalResumeIndex, ARCHIVE_ROOT } from './local_resume.mjs'

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const daysArg = args.indexOf('--days')
const root = dirArg >= 0 ? args[dirArg + 1] : ARCHIVE_ROOT
const sinceDays = args.includes('--all') ? null : (daysArg >= 0 ? Number(args[daysArg + 1]) : 3)

console.log(`控え: ${root}（${sinceDays == null ? '全件' : `直近${sinceDays}日`}）`)
const r = refreshLocalResumeIndex({ root, sinceDays })
if (!r) {
  console.error(`控えのフォルダが見つかりません: ${root}`)
  process.exit(1)
}
console.log(`走査 ${r.scanned} 件 / 新しく索引に入れた ${r.added} 件 / 索引合計 ${r.indexed} 件（${(r.ms / 1000).toFixed(1)}秒）`)
