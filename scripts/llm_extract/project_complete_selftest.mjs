#!/usr/bin/env node
// project_complete_selftest.mjs — projectLooksComplete の単体テスト
//
// この関数は「LLM を呼ばずに済ませる」判定なので、誤って true を返すと
// 案件の補正が丸ごと行われなくなる。false 側（＝LLMを通す）に倒れる方が安全なため、
// 「1項目でも欠けたら false」を全項目ぶん確認する。
//
// 実行: node scripts/llm_extract/project_complete_selftest.mjs
import { projectLooksComplete } from './shadow_worker_lib.mjs'
import { DEFAULT_TITLE } from './project_apply.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) pass++
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)} exp=${JSON.stringify(expect)}`) }
}

/** 全項目が埋まった案件（＝LLMを省略してよい状態） */
const full = {
  title: 'ECサイト刷新のバックエンド開発',
  client: '株式会社エンドユーザー',
  budget_min: 60,
  budget_max: 70,
  work_location: '東京都港区（品川駅）',
  contract_type: '準委任',
  required_skills: ['Java', 'Spring Boot'],
}
const without = (key, val) => projectLooksComplete({ ...full, [key]: val }, DEFAULT_TITLE)

t('全項目そろえば省略できる', projectLooksComplete(full, DEFAULT_TITLE), true)

// title は inbound-email のフォールバック値なら「未入力」扱い（project_apply.mjs と同じ規則）
t('titleがフォールバック値なら省略しない', without('title', DEFAULT_TITLE), false)
t('titleが空なら省略しない', without('title', ''), false)

// 各項目の欠落 — すべて「省略しない(false)」に倒れること
t('client欠落', without('client', null), false)
t('budget_min欠落', without('budget_min', null), false)
t('budget_max欠落', without('budget_max', null), false)
t('work_location欠落', without('work_location', null), false)
t('contract_type欠落', without('contract_type', null), false)

// required_skills はマッチング精度に直結するため空なら必ずLLMを通す
t('required_skillsが空配列', without('required_skills', []), false)
t('required_skillsがnull', without('required_skills', null), false)

// 異常入力でも例外を投げず false（＝LLMを通す）に倒れること
t('nullの案件', projectLooksComplete(null, DEFAULT_TITLE), false)
t('undefinedの案件', projectLooksComplete(undefined, DEFAULT_TITLE), false)
t('空オブジェクト', projectLooksComplete({}, DEFAULT_TITLE), false)

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
