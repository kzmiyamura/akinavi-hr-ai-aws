#!/usr/bin/env node
// =============================================================================
// parseNearestStation 回帰テスト
// =============================================================================
// 使い方: node scripts/test_station_parse.mjs
//
// index.ts から自動生成された _extractors.gen.mjs を読むので、手書きレプリカと
// 違って本番と食い違わない。index.ts を直したら sync_extractors.mjs を先に流すこと。
// =============================================================================
import { parseNearestStation } from './_extractors.gen.mjs'

// [入力, 期待する駅名, 期待する路線名(undefined=見ない)]
const CASES = [
  // ── 路線名 → 駅名 の順（従来から通っていた書式） ──
  ['JR京浜東北線／蕨駅',                  '蕨駅',        'JR京浜東北線'],
  ['西武池袋線・東長崎駅',                '東長崎駅',    '西武池袋線'],
  ['西武池袋線　飯能駅',                  '飯能駅',      '西武池袋線'],
  ['JR総武線「市川」',                    '市川',        'JR総武線'],
  ['小田急小田原線本厚木駅',              '本厚木駅',    '小田急小田原線'],
  ['横浜市営地下鉄ブルーライン　駅 三ツ沢下町', '三ツ沢下町', '横浜市営地下鉄ブルーライン'],
  ['名鉄 犬山駅 ※愛知',                   '犬山駅',      null],

  // ── 駅名 → 路線名 の順（2026-08-20 に路線名だけ残っていた書式） ──
  ['東久留米・西武池袋線',                '東久留米',    '西武池袋線'],
  ['所沢駅・西武新宿線',                  '所沢駅',      '西武新宿線'],
  ['町田/JR横浜線',                       '町田',        'JR横浜線'],
  ['桜台(西武池袋線)',                    '桜台',        '西武池袋線'],
  ['綾瀬駅（東京メトロ千代田線 / JR常磐線）', '綾瀬駅',   '東京メトロ千代田線'],

  // ── 路線名なし・注記つき ──
  ['東久留米',                            '東久留米',    null],
  ['最寄：北13条東駅',                    '北13条東駅',  null],
  ['二子玉川※常駐可能',                  '二子玉川',    null],
  ['幸手※都内出勤可',                    '幸手',        null],
  ['汐入駅常駐可',                        '汐入駅',      null],
  ['京浜急行線　井土ヶ谷駅（徒歩5分）',   '井土ヶ谷駅',  '京浜急行線'],

  // ── 事業者名プレフィックス ──
  ['横浜市営地下鉄岸根公園',              '岸根公園',    null],
  ['地下鉄成増',                          '地下鉄成増',  null],  // 事業者名で始まる正式駅名

  // ── 駅名自体が「線」を含む駅を壊さない ──
  ['新線新宿',                            '新線新宿',    null],
  ['日本ライン今渡',                      '日本ライン今渡', null],
  ['西線９条旭山公園通',                  '西線９条旭山公園通', null],

  // ── ラベルが値に混ざったケース（駅名側を拾う） ──
  ['最寄　東久留米',                      '東久留米',    null],
  ['沿線：西武池袋線 東久留米駅',         '東久留米駅',  '西武池袋線'],

  // ── 空・ラベルのみ ──
  ['',                                    null,          null],
  ['最寄駅',                              null,          null],
]

let passed = 0
let failed = 0
for (const [input, expStation, expLine] of CASES) {
  const got = parseNearestStation(input)
  const okStation = got.station === expStation
  const okLine = expLine === undefined || got.line === expLine
  if (okStation && okLine) {
    passed++
  } else {
    failed++
    console.log(`❌ ${JSON.stringify(input)}`)
    if (!okStation) console.log(`   station: got ${JSON.stringify(got.station)} / want ${JSON.stringify(expStation)}`)
    if (!okLine)    console.log(`   line   : got ${JSON.stringify(got.line)} / want ${JSON.stringify(expLine)}`)
  }
}
console.log(`\n📊 ${passed} passed / ${failed} failed（全${CASES.length}ケース）`)
process.exit(failed ? 1 : 0)
