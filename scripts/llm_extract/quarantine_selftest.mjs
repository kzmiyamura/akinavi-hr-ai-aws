#!/usr/bin/env node
// quarantine_selftest.mjs — 非人材検知（隔離）の条件を固定する（2026-08-19）
//
// 実害: Haiku が人材紹介メールを mailType='other' と誤判定し、本物の人材10件が
// 一覧から消えていた（Issue #170〜#180 の乱立の正体）。
// 旧実装の第2条件「AI が返した人物に使える氏名が無い」は、
// **AI が other と判断すれば人物も返さない**ため第1条件の副産物で、
// 二重チェックとして機能していなかった。
//
// 実行: node scripts/llm_extract/quarantine_selftest.mjs
import { isUsableName } from './apply.mjs'
import { looksLikeCandidateSubject } from './shadow_worker_lib.mjs'

let pass = 0, fail = 0
const t = (label, actual, expected) => {
  const ok = actual === expected
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}  期待:${expected} 実際:${actual}`) }
}

/** shadow_worker.mjs の隔離条件と同じ式（ここを変えたら worker 側も直すこと） */
function shouldQuarantine({ candidateName, aiMailType, aiCandidates, subject }) {
  const regexFoundPerson = isUsableName(candidateName)
  const aiFoundPerson = (aiCandidates ?? []).some(x => isUsableName(x?.name))
  const noUsablePerson = !regexFoundPerson && !aiFoundPerson
  const subjectSaysCandidate = looksLikeCandidateSubject(subject)
  return Boolean(aiMailType && aiMailType !== 'candidate' && noUsablePerson && !subjectSaysCandidate)
}

console.log('— 隔離すべきもの —')
t('営業の定期配信で氏名も取れていない',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'other', aiCandidates: [], subject: '◆Trinitas営業情報◆定期配信' }), true)
t('案件メールで氏名も取れていない',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'project', aiCandidates: [], subject: '★超注力★会計パッケージ React + TypeScript' }), true)

console.log('— 隔離してはいけないもの（2026-08-19 の実害）—')
t('AIが other と誤判定しても regex が氏名を取れていれば残す',
  shouldQuarantine({ candidateName: 'NT', aiMailType: 'other', aiCandidates: [], subject: '株式会社Branding Engineer 営業人材一覧' }), false)
t('件名が「直人材」なら残す',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'other', aiCandidates: [], subject: '☆彡【直人材】TypeScript(React)/JavaScript' }), false)
t('件名が「弊社社員」なら残す',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'other', aiCandidates: [], subject: '【弊社社員】Java/JavaScript/SpringBoot' }), false)
t('件名が「弊社FL」なら残す',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'other', aiCandidates: [], subject: '☆彡【弊社FL】TypeScript/React/HTML' }), false)
t('AIが人物を返していれば残す（従来どおり）',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'other', aiCandidates: [{ name: 'T.K' }], subject: '案件のご案内' }), false)
t('AIが candidate と判定したら隔離しない',
  shouldQuarantine({ candidateName: '不明', aiMailType: 'candidate', aiCandidates: [], subject: '案件のご案内' }), false)
t('AIの判定が無ければ隔離しない',
  shouldQuarantine({ candidateName: '不明', aiMailType: null, aiCandidates: [], subject: '案件のご案内' }), false)

console.log('— 件名判定そのもの —')
t('「人材情報」を人材紹介と見る', looksLikeCandidateSubject('【人材情報】即日〜 Java'), true)
t('「要員一覧」を人材紹介と見る', looksLikeCandidateSubject('8月要員一覧'), true)
t('ただの案件件名は人材紹介と見ない', looksLikeCandidateSubject('★急募★ Java 開発案件 60〜70万'), false)
t('空件名は false', looksLikeCandidateSubject(''), false)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exitCode = fail === 0 ? 0 : 1
