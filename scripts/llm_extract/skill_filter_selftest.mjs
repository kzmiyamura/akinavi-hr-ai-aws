#!/usr/bin/env node
// skill_filter_selftest.mjs — AI校正対象のスキル絞り込みの単体テスト
//
// この条件を誤ると「対象者を1人も拾わない」または「絞れていない」のどちらかになり、
// 前者は営業機会の損失、後者は費用の垂れ流しになる。特に:
//   ・app_config.value は形式がまちまち（二重エンコードの実例あり）
//   ・C# の # は URL のフラグメント記号なので必ずエンコードされること
//
// 実行: node scripts/llm_extract/skill_filter_selftest.mjs
import { parseSkillFilterValue, buildSkillFilterClause, pgSkillWordPattern, pgRegexEscape } from './shadow_worker_lib.mjs'

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
t('本文は語境界付きの imatch', one.includes('raw_profile->>text.imatch.'), true)
t('本文の部分一致（ilike）は残っていない', one.includes('ilike'), false)

// ── 語境界の正規表現 ──
// Java が JavaScript を拾っていた（2026-08-14）。CLAUDE.md §6「部分一致は使わない」
const pgTest = (skill, text) => {
  const p = pgSkillWordPattern(skill)
  // PostgreSQL の ARE 相当として JS 正規表現で近似検証する（メタ文字はブラケット式で無害化済み）
  return new RegExp(p, 'i').test(text)
}
t('Java は JavaScript に当たらない', pgTest('Java', 'JavaScript、jQuery、Figma'), false)
t('Java は Java に当たる', pgTest('Java', 'Java / Spring Boot'), true)
t('Java は日本語に挟まれても当たる', pgTest('Java', 'Java経験5年'), true)
t('Java は行頭・行末でも当たる', pgTest('Java', 'Java'), true)
t('C は C# に当たらない', pgTest('C', 'C#, VB.net'), false)
t('C# は C#.NET に当たる', pgTest('C#', 'C#.NET 開発'), true)
t('C++ は C に当たらない', pgTest('C', 'C++ での開発'), false)
t('C++ は C++ に当たる', pgTest('C++', '言語: C++'), true)
t('Shell は PowerShell に当たらない', pgTest('Shell', 'PowerShell スクリプト'), false)
t('.NET のドットはメタ文字にならない', pgTest('.NET', '使用: .NET Framework'), true)
t('ドットが任意1文字にならない', pgTest('.NET', '使用: XNET'), false)

t('メタ文字はブラケット式になる', pgRegexEscape('C++'), 'C[+][+]')
t('バックスラッシュを含む名前は表現不能', pgRegexEscape('a\\b'), null)
const backslash = buildSkillFilterClause(['a\\b'])
t('表現不能な名前は ilike に退避する', backslash.includes('ilike'), true)

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
