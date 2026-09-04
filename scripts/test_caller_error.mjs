#!/usr/bin/env node
// claude -p の異常終了メッセージの回帰テスト。
//
// 2026-08-26〜27 に exit=1 が62件発生したが、ログには `Error: exit=1 ` としか残らず
// 原因を追えなかった。stderr が空で、CLI の出力が stdout 側にあったため。
//
// 使い方: node scripts/test_caller_error.mjs
import { formatSpawnError } from './llm_extract/caller.mjs'

let pass = 0, fail = 0
const eq = (title, got, want) => {
  if (got === want) { pass++; console.log(`  ✅ ${title}`) }
  else { fail++; console.log(`  ❌ ${title}\n     期待: ${want}\n     実際: ${got}`) }
}

console.log('=== 異常終了メッセージ ===')
eq('stderr があればそれを載せる',
  formatSpawnError(1, 'Error: usage limit reached', ''),
  'exit=1 Error: usage limit reached')

eq('stderr が空なら stdout を載せる（今回の実害）',
  formatSpawnError(1, '', 'Claude usage limit reached. Your limit will reset at 3pm.'),
  'exit=1 Claude usage limit reached. Your limit will reset at 3pm.')

eq('stderr が空白だけでも stdout を載せる',
  formatSpawnError(1, '   \n  ', 'something went wrong'),
  'exit=1 something went wrong')

eq('両方空なら「出力なし」と明示する（以前は末尾が空で判別できなかった）',
  formatSpawnError(1, '', ''),
  'exit=1 (stdout/stderr とも出力なし)')

eq('null / undefined でも落ちない',
  formatSpawnError(137, null, undefined),
  'exit=137 (stdout/stderr とも出力なし)')

eq('300文字で切る',
  formatSpawnError(1, 'x'.repeat(500), ''),
  `exit=1 ${'x'.repeat(300)}`)

console.log(`\n合計: ${pass} 通過 / ${fail} 失敗`)
process.exit(fail === 0 ? 0 : 1)
