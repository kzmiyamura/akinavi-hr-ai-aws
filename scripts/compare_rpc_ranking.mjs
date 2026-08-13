/**
 * compare_rpc_ranking.mjs
 * snapshot_rpc_ranking.mjs が出した2つのスナップショットを突き合わせる。
 * RPC を書き換えたときに配点・並びが変わっていないことの確認用。
 *
 * Usage: node scripts/compare_rpc_ranking.mjs <before.json> <after.json>
 */
import { readFileSync } from 'fs'

const a = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const b = JSON.parse(readFileSync(process.argv[3], 'utf8'))

let ok = 0, diff = 0, skipped = 0
for (const id of Object.keys(b)) {
  const before = a[id], after = b[id]
  const label = id.slice(0, 8)
  if (!before || before.error) { console.log(`SKIP ${label} 比較前がエラー（${before?.error?.slice(0, 40) ?? '無し'}）`); skipped++; continue }
  if (after.error) { console.log(`NG   ${label} 比較後がエラー: ${after.error.slice(0, 40)}`); diff++; continue }

  const setA = new Set(before.ids), setB = new Set(after.ids)
  const onlyA = before.ids.filter(x => !setB.has(x))
  const onlyB = after.ids.filter(x => !setA.has(x))
  const sameOrder = before.ids.length === after.ids.length && before.ids.every((x, i) => x === after.ids[i])
  const firstDiff = before.ids.findIndex((x, i) => x !== after.ids[i])

  if (sameOrder) {
    console.log(`OK   ${label} ${after.ids.length}件 完全一致  ${before.ms}ms → ${after.ms}ms`)
    ok++
  } else if (onlyA.length === 0 && onlyB.length === 0) {
    console.log(`WARN ${label} 顔ぶれは同じだが並びが違う（最初の相違 ${firstDiff}位目）  ${before.ms}ms → ${after.ms}ms`)
    diff++
  } else {
    console.log(`NG   ${label} 顔ぶれが違う 前のみ${onlyA.length}件 / 後のみ${onlyB.length}件  ${before.ms}ms → ${after.ms}ms`)
    diff++
  }
}
console.log(`\n完全一致 ${ok} / 相違 ${diff} / 比較不能 ${skipped}`)
process.exit(diff > 0 ? 1 : 0)
