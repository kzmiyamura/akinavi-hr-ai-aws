#!/usr/bin/env node
// test_parse_ym.mjs — parseYM（LLM出力の年月パース）の単体テスト
//
// プロンプトでは和暦を西暦に直すよう指示しているが、**指示どおりに返る保証はない**。
// ここで拾えないと skillYears が丸ごと空になる（TK / MK は和暦だけの経歴書）。
//
// 実行: node scripts/test_parse_ym.mjs
import { parseYM, NOW_YM } from './llm_extract/lib.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) { pass++ } else { fail++; console.log(`  FAIL ${label}: got=${got} exp=${expect}`) }
}
const ym = (y, m) => y * 12 + m

// ── 西暦（従来） ──
t('2024/05', parseYM('2024/05'), ym(2024, 5))
t('2024年5月', parseYM('2024年5月'), ym(2024, 5))
t('2024.5', parseYM('2024.5'), ym(2024, 5))
t('present', parseYM('present'), NOW_YM)
t('現在', parseYM('現在'), NOW_YM)
t('空', parseYM(''), null)
t('日付でない', parseYM('Java'), null)

// ── 和暦（2026-08-14 追加。令和1年=2019年） ──
t('R7.9 → 2025/09', parseYM('R7.9'), ym(2025, 9))
t('R6/1 → 2024/01', parseYM('R6/1'), ym(2024, 1))
t('令和8年4月 → 2026/04', parseYM('令和8年4月'), ym(2026, 4))
t('H28/4 → 2016/04', parseYM('H28/4'), ym(2016, 4))
t('平成30年3月 → 2018/03', parseYM('平成30年3月'), ym(2018, 3))
t('S60/1 → 1985/01', parseYM('S60/1'), ym(1985, 1))
t('小文字 r7.9', parseYM('r7.9'), ym(2025, 9))

// ── 和暦と紛らわしいもの（月が無いので日付ではない） ──
t('S3（AWS）は日付でない', parseYM('S3'), null)
t('H2（データベース）は日付でない', parseYM('H2'), null)
t('R は日付でない', parseYM('R'), null)
// 西暦が先に見つかる場合は従来どおり西暦を優先する
t('混在は西暦優先', parseYM('2024/05（R6/5）'), ym(2024, 5))

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
