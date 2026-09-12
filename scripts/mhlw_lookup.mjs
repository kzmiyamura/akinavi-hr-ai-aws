#!/usr/bin/env node
/**
 * 厚労省「人材サービス総合サイト」に会社名で問い合わせ、許可番号が取れるか確かめる。
 *
 *   node scripts/mhlw_lookup.mjs "株式会社さくらケーシーエス" ["別の社名" ...]
 *   node scripts/mhlw_lookup.mjs --raw "GFD"      # 表記ゆれを試さず、そのキー1本だけ引く
 *
 * `license_status` が本当に「免許なし」なのか、単に「この社名では引けなかった」
 * だけなのかを、DB を書き換えずに切り分けるためのもの。
 * 検索キーの作り方は verify-agent-license/index.ts から切り出して使う（写しを作らない）。
 */

import { lookupCompany, searchByName, searchByNumber, searchVariants, sleep } from './lib/mhlw.mjs'

const args = process.argv.slice(2)
const raw = args.includes('--raw')
const byNumber = args.includes('--number')
const names = args.filter((a) => !a.startsWith('--'))
if (names.length === 0) {
  console.error('使い方: node scripts/mhlw_lookup.mjs [--raw|--number] "<会社名 または 派XX-XXXXXX>" ...')
  process.exit(1)
}

for (const [i, name] of names.entries()) {
  if (i > 0) await sleep(1500)
  try {
    if (byNumber) {
      const entries = await searchByNumber(name)
      console.log(`${name}`)
      for (const e of entries) console.log(`  ${e.number}  ${e.name}`)
      if (entries.length === 0) console.log('  （該当なし）')
      continue
    }
    if (raw) {
      const r = await searchByName(name)
      console.log(`${name}\n  派遣=${r.haken.join(',') || '-'} 紹介=${r.shokai.join(',') || '-'}`)
      console.log(`  事業主名: ${r.names.slice(0, 5).join(' / ') || '-'}`)
      continue
    }
    const r = await lookupCompany(name)
    console.log(`${name} → ${r.status}`)
    console.log(`  試したキー: ${r.tried.join(' / ')}`)
    if (r.hit) {
      console.log(`  一致したキー: ${r.matchedKey}`)
      console.log(`  派遣=${r.haken.join(',') || '-'} 紹介=${r.shokai.join(',') || '-'}`)
      console.log(`  事業主名: ${r.names.slice(0, 5).join(' / ') || '-'}`)
    } else {
      console.log(`  候補キー全滅（=このサイトに登録が無い。免許なしとは限らない）`)
      console.log(`  ※ 未試行のキー: ${searchVariants(name).filter((k) => !r.tried.includes(k)).join(' / ') || 'なし'}`)
    }
  } catch (e) {
    console.log(`${name}\n  ERROR ${String(e)}`)
  }
}
