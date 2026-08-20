#!/usr/bin/env node
// test_role_family_hint.mjs — 役割系統ヒントの条件を固定する（2026-08-20）
//
// 背景（ユーザー提案）:
//   1メール1人材のとき、件名（例:「【BP社員/PHP/9月〜】【e-studio】RT31川口」）には
//   スキルしか書かれておらず役割語が無い。それでも「技術寄りの人」だとは読める。
//
// 方針:
//   具体的な役割（PG/TL/SE）は決めない。**外した役割はマッチングで減点(-9)になる**ため、
//   「実装系寄り」という系統だけを、役割がまったく取れなかった人に限って記録する。
//
// 実行: node scripts/test_role_family_hint.mjs
import { inferRoleFamilyHint } from './_extractors.gen.mjs'

let pass = 0, fail = 0
const t = (label, actual, expected) => {
  const ok = actual === expected
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}  期待:${expected} 実際:${actual}`) }
}
const fam = (roles, cats, text) => inferRoleFamilyHint(roles, cats, text)?.family ?? null

const TECH = { languages: ['PHP', 'JavaScript'], databases: ['MySQL'] }

console.log('— 付ける場合 —')
t('役割語が無く技術3件（件名にスキルだけ）',
  fam([], TECH, '【BP社員/PHP/9月〜】【e-studio】RT31川口\nWebシステムの開発を担当。'), 'implementation')
t('クラウド・インフラ系でも付く',
  fam([], { clouds: ['AWS'], infrastructures: ['Docker'], os: ['Linux'] }, 'インフラ構築を担当。'), 'implementation')

console.log('— 付けない場合 —')
t('役割が1つでも取れていれば触らない',
  fam(['システムエンジニア'], TECH, 'SEとして開発を担当。'), null)
t('技術が2件以下なら付けない（案件説明の巻き添え対策）',
  fam([], { languages: ['PHP'], databases: ['MySQL'] }, 'PHPの案件です。'), null)
t('管理寄りの語があれば断定しない（進捗管理）',
  fam([], TECH, 'PHP開発チームの進捗管理を担当していました。'), null)
t('管理寄りの語があれば断定しない（折衝）',
  fam([], TECH, '顧客折衝から実装まで対応。'), null)
t('スキルが空なら付けない', fam([], {}, '人材のご紹介です。'), null)
t('カテゴリが技術系でなければ付けない（工程・資格のみ）',
  fam([], { methodologies: ['要件定義', '基本設計', 'テスト'], certifications: ['MOS'] }, '各工程を担当。'), null)

console.log('— 根拠が残る —')
{
  const r = inferRoleFamilyHint([], TECH, '【BP社員/PHP/9月〜】')
  t('reason に技術名が入る', /PHP/.test(r?.reason ?? ''), true)
  t('reason に件数が入る', /3件/.test(r?.reason ?? ''), true)
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exitCode = fail === 0 ? 0 : 1
