#!/usr/bin/env node
/**
 * 監査で見つかった系統的な誤りの規模を測る。
 *
 * 2026-09-19 の抜き取り監査で、分類器が p=0.924 で「インフラ」と判定した人を
 * AI が high confidence で否定した:
 *   「主業務はPMO・プロジェクト管理。インフラは構築に伴う業務フロー策定のみで、
 *     直接的な設計・構築・運用経験なし」（件名も ★★【おすすめ人材！】PMO★★）
 *
 * つまり **基盤案件を管理していた人**は、スキル構成が基盤の人と見分けられない。
 * 管理した案件の技術がスキル欄に並ぶため、特徴量空間では同じ場所に立つ。
 * これは閾値付近を見ても永久に見つからない種類の誤りなので、規模を数える。
 *
 * ローカル控えだけを使う（本番を引かない＝egress ゼロ）。
 */
import { loadRows, featurize, weakLabel } from './dataset.mjs'

const MGMT_ROLES = ['PMO', 'プロジェクトマネージャー', 'プロジェクトリーダー', 'コンサルタント']

const rows = loadRows()
let posTotal = 0
const overlap = new Map()
let bothMgmtAndStrong = 0
const samples = []

for (const r of rows) {
  const w = weakLabel(r)
  if (w.label !== 1) continue           // 分類器が正例として学ぶ側だけを見る
  posTotal++
  const roles = Array.isArray(r.rp_roles) ? r.rp_roles : []
  const mgmt = roles.filter((x) => MGMT_ROLES.includes(x))
  if (!mgmt.length) continue
  for (const m of mgmt) overlap.set(m, (overlap.get(m) ?? 0) + 1)
  const f = featurize(r)
  // 「管理役割を持ち、かつ自分では基盤の語を名乗っていない」＝いちばん危ない層
  if (!roles.includes('インフラエンジニア')) {
    bothMgmtAndStrong++
    if (samples.length < 6) {
      samples.push(`${String(r.name ?? '').padEnd(12)} ${mgmt.join(',')}  基盤${f.base_n}/開発${f.dev_n} 強技術${f.strong_infra_skills}  ${String(r.rp_subject ?? '').slice(0, 52)}`)
    }
  }
}

console.log(`弱教師が「基盤の人」とした正例: ${posTotal}人\n`)
console.log('■ そのうち管理側の役割も持っている人')
for (const [k, n] of [...overlap].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(n).padStart(4)}人  (正例の ${(n / posTotal * 100).toFixed(1)}%)`)
}
console.log(`\n■ 管理役割を持ち、かつ自分では「インフラ」を名乗っていない: ${bothMgmtAndStrong}人`)
console.log(`   (正例の ${(bothMgmtAndStrong / posTotal * 100).toFixed(1)}%。ここが誤分類の本体)`)
console.log('\n■ 例')
for (const s of samples) console.log(`  ${s}`)
