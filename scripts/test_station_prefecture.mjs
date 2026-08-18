// 駅名→都道府県の解決テスト（2026-08-18）
//
// 実害: 「【最寄】東武東上線 霞ヶ関駅(埼玉県)」が東京都として登録された。
//   原因1: ヶ→ケ 正規化が別駅を潰す（霞ヶ関=東武東上線/埼玉、霞ケ関=東京メトロ/東京）
//   原因2: ハードコードマップの '霞ヶ関' が東京都（値が逆）
//   原因3: 本文に明記された「(埼玉県)」が使われていない
//
// 判定ロジックは _extractors.gen.mjs 経由で index.ts の実物を読む（レプリカを持たない）。
// index.ts を変更したら先に node scripts/sync_extractors.mjs を実行すること。
//
//   node scripts/test_station_prefecture.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { extractPrefectureFromStationText, stationNameCandidates } from './_extractors.gen.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB = JSON.parse(readFileSync(join(__dirname, '../supabase/functions/inbound-email/station_data.json'), 'utf8'))
const genSrc = readFileSync(join(__dirname, '_extractors.gen.mjs'), 'utf8')

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── 1. 明示された都道府県が最優先 ────────────────────────────
check('明示: 東武東上線 霞ヶ関駅(埼玉県) → 埼玉県',
  extractPrefectureFromStationText('東武東上線 霞ヶ関駅(埼玉県)') === '埼玉県')
check('明示: ※神奈川 のような接尾辞なし表記も拾う',
  extractPrefectureFromStationText('名鉄 犬山駅 ※神奈川') === '神奈川県')
check('明示なしなら null（推定に委ねる）',
  extractPrefectureFromStationText('霞ヶ関駅') === null)
check('明示なし: 路線名だけでは県を作らない',
  extractPrefectureFromStationText('東武東上線 霞ヶ関駅') === null)

// ── 2. ヶ/ケ を潰さない（原表記が先） ───────────────────────
{
  const cands = stationNameCandidates('東武東上線 霞ヶ関駅')
  const iRaw = cands.indexOf('霞ヶ関')
  const iNorm = cands.indexOf('霞ケ関')
  check('候補に原表記「霞ヶ関」が含まれる', iRaw >= 0, JSON.stringify(cands))
  check('候補に正規化形「霞ケ関」も残る（保土ヶ谷対策）', iNorm >= 0)
  check('原表記が正規化形より先に来る', iRaw >= 0 && iNorm >= 0 && iRaw < iNorm,
    `霞ヶ関=${iRaw} 霞ケ関=${iNorm}`)
}

// ── 3. データ側の事実（この前提が崩れたら上の修正は無意味） ──
check('station_data: 霞ヶ関 = 東武東上線・埼玉県',
  DB['霞ヶ関']?.every(e => e.prefecture === '埼玉県') && DB['霞ヶ関']?.some(e => e.line.includes('東武東上線')))
check('station_data: 霞ケ関 = 東京メトロ・東京都',
  DB['霞ケ関']?.every(e => e.prefecture === '東京都'))

// ── 4. ハードコードマップの事実誤りが消えている ──────────────
check("ハードコードから '霞ヶ関': '東京都' が消えている",
  !/'霞ヶ関'\s*:\s*'東京都'/.test(genSrc))
check("ハードコードから '町田': '神奈川県' が消えている（町田駅は東京都）",
  !/'町田'\s*:\s*'神奈川県'/.test(genSrc))

// ── 5. 保土ヶ谷（正規化が必要な既存ケース）を壊していない ────
{
  const cands = stationNameCandidates('JR横須賀線 保土ヶ谷駅')
  const hit = cands.find(c => DB[c])
  check('保土ヶ谷: 正規化フォールバックでDB命中する',
    !!hit && DB[hit].every(e => e.prefecture === '神奈川県'), `命中=${hit}`)
}

const failed = results.filter(r => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length) { console.log('失敗:', failed.map(f => f.name).join(', ')); process.exit(1) }
