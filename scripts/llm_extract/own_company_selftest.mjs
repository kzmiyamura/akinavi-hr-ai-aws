#!/usr/bin/env node
// own_company_selftest.mjs — AI が返した所属会社の後始末を固定する（2026-08-17）
//
// 実害: R.I の所属会社が「株式会社ボイス」（＝当社・メール冒頭の宛先）になっていた。
// regex の誤値「株式会社CyTechから社名変更になります」を AI が"修正"した結果。
// 正しくは署名にある「株式会社ai・more」。
//
// 実行: node scripts/llm_extract/own_company_selftest.mjs
import { sanitizeAiCompany } from './apply.mjs'
import { isOwnCompany } from './own_company.mjs'

let pass = 0, fail = 0
const t = (label, actual, expected) => {
  const ok = actual === expected
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}\n     期待: ${JSON.stringify(expected)}\n     実際: ${JSON.stringify(actual)}`) }
}

// 当社名は所属会社にしない
t('株式会社ボイスは弾く', sanitizeAiCompany('株式会社ボイス'), null)
t('表記ゆれ（i-voice）も弾く', sanitizeAiCompany('i-voice株式会社'), null)
t('アキナビも弾く', sanitizeAiCompany('株式会社アキナビ'), null)
t('isOwnCompany: 空文字は false', isOwnCompany(''), false)
t('isOwnCompany: 他社は false', isOwnCompany('株式会社ai・more'), false)

// 社名でない付随表現を落とす
t('「〜から社名変更になります」の注記を落とす',
  sanitizeAiCompany('株式会社CyTechから社名変更になります'), null)
t('社名＋注記なら社名だけ残す',
  sanitizeAiCompany('株式会社ai・more(株式会社CyTechから社名変更になります。)'), '株式会社ai・more')
t('末尾の敬称を落とす', sanitizeAiCompany('株式会社エクスプラザ様'), '株式会社エクスプラザ')
t('御中も落とす', sanitizeAiCompany('株式会社エクスプラザ御中'), '株式会社エクスプラザ')
t('行頭の記号を落とす', sanitizeAiCompany('・株式会社GFD'), '株式会社GFD')

// 正常な社名はそのまま
t('通常の社名はそのまま', sanitizeAiCompany('株式会社ai・more'), '株式会社ai・more')
t('英語社名もそのまま', sanitizeAiCompany('Next IT Consulting株式会社'), 'Next IT Consulting株式会社')
t('null は null', sanitizeAiCompany(null), null)
t('空白だけは null', sanitizeAiCompany('   '), null)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exitCode = fail === 0 ? 0 : 1
