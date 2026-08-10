#!/usr/bin/env node
// skill_filter_selftest.mjs — AI校正対象のスキル絞り込みの単体テスト
//
// この条件を誤ると「対象者を1人も拾わない」または「絞れていない」のどちらかになり、
// 前者は営業機会の損失、後者は費用の垂れ流しになる。特に:
//   ・app_config.value は形式がまちまち（二重エンコードの実例あり）
//   ・C# の # は URL のフラグメント記号なので必ずエンコードされること
//
// 実行: node scripts/llm_extract/skill_filter_selftest.mjs
import { parseSkillFilterValue, buildSkillFilterClause } from './shadow_worker_lib.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (JSON.stringify(got) === JSON.stringify(expect)) pass++
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)}\n    exp=${JSON.stringify(expect)}`) }
}

// ── 設定値の解釈 ──
t('配列そのまま', parseSkillFilterValue(['Java', 'C#']), ['Java', 'C#'])
t('JSON文字列', parseSkillFilterValue('["Java","C#"]'), ['Java', 'C#'])
t('二重エンコード', parseSkillFilterValue('"[\\"Java\\"]"'), ['Java'])
t('前後の空白は落とす', parseSkillFilterValue([' Java ', 'C#']), ['Java', 'C#'])
t('空要素は捨てる', parseSkillFilterValue(['Java', '', '  ']), ['Java'])

// 絞り込み無効を表すもの（すべて null＝全件対象）。ここを取り違えると全件が落ちる
t('未設定', parseSkillFilterValue(undefined), null)
t('null', parseSkillFilterValue(null), null)
t('空配列', parseSkillFilterValue([]), null)
t('空配列のJSON文字列', parseSkillFilterValue('[]'), null)
t('配列でない真偽値', parseSkillFilterValue('true'), null)
t('配列でないオブジェクト', parseSkillFilterValue({ a: 1 }), null)
t('壊れたJSON', parseSkillFilterValue('[Java'), null)

// ── 条件の組み立て ──
t('絞り込み無しなら空文字', buildSkillFilterClause(null), '')
t('空配列なら空文字', buildSkillFilterClause([]), '')

const one = buildSkillFilterClause(['Java'])
t('or() で囲む', one.startsWith('&or=(') && one.endsWith(')'), true)
t('skills と本文の2条件が出る', one.split(',').length, 2)
t('skills は jsonb 包含でエンコードされる', one.includes(encodeURIComponent('["Java"]')), true)
t('本文は前後ワイルドカードの ilike', one.includes('raw_profile->>text.ilike.*Java*'), true)

// # をエンコードし損ねると URL のフラグメント扱いになり条件が丸ごと消える
const sharp = buildSkillFilterClause(['C#'])
t('C# の # がエンコードされる', sharp.includes('%23'), true)
t('生の # が残らない', sharp.includes('#'), false)

const two = buildSkillFilterClause(['Java', 'C#'])
t('2スキルで4条件', two.split(',').length, 4)
// PostgREST の構文（カンマ・括弧・ドット）は壊さないこと
t('括弧はエンコードしない', two.includes('&or=('), true)

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
