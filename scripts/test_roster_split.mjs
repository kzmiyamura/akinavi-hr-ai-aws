#!/usr/bin/env node
// 名簿メールの分割と、件名からの役割漏れの回帰テスト。
// 本物の splitMultiCandidateBody / extractFromProse を使う（手写しのレプリカにしない）。
//
// 使い方: node scripts/test_roster_split.mjs
import { splitMultiCandidateBody, extractFromProse } from './_extractors.gen.mjs'

let pass = 0, fail = 0
const ok = (title, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${title}`) }
  else { fail++; console.log(`  ❌ ${title}${detail ? ' … ' + detail : ''}`) }
}

console.log('=== 氏名欄の記号つき表記で分割できること ===')
// 2026-08-29 実測: 「●名前：」形式が分割できず、9社93人が1レコードに詰め込まれていた。
// 「●氏名：」は拾えるのに「●名前：」だけ記号を許していなかった。
{
  const body = [
    'お世話になっております。弊社社員のご紹介です。',
    '---------------------------------------',
    '★乗車60分程度まで希望(常駐可)',
    '●名前　：MK',
    '●性別　：男性',
    '●年齢　：26歳',
    '●最寄　：板橋区役所前',
    '●スキル：Windows,Linuxサーバ 運用,ヘルプデスク,キッティング',
    '━━━━━━━━━━━━━━━━━━━━',
    '★乗車45分程度希望(常駐可)',
    '●名前　：KS',
    '●性別　：男性',
    '●年齢　：40歳',
    '●最寄　：鷺ノ宮',
    '●スキル：Java(SpringBoot) 基本設計～,サブリーダー',
  ].join('\n')
  const blocks = splitMultiCandidateBody(body)
  ok('「●名前：」2人ぶんを分割する', (blocks?.length ?? 0) >= 2, `got ${blocks?.length ?? 'null'}`)
}
{
  // 1人だけのメールを誤って分割しない
  const body = [
    '弊社社員のご紹介です。',
    '●名前　：KH',
    '●性別　：男性',
    '●年齢　：33歳',
    '●スキル：AWS, Terraform, Kubernetes',
  ].join('\n')
  const blocks = splitMultiCandidateBody(body)
  ok('1人メールは分割しない', blocks === null || blocks.length <= 1, `got ${blocks?.length ?? 'null'}`)
}

console.log('\n=== 件名の役割が全員に漏れないこと ===')
// 2026-08-29 実測: 件名「【弊社直人材】PMO/生保/小売/…」で21人全員にPMOが付いた。
// 件名「…(サーバ運用,Java,社内SE)」で6ブロック中5つにシステムエンジニアが漏れた。
{
  const subject = '※単金調整【Miraie塩田】弊社社員のご紹介(サーバ運用,Java,社内SE)'
  const block = '●名前　：MK\n●年齢　：26歳\n●スキル：Windows,Linuxサーバ 運用,ヘルプデスク,キッティング'
  const withSubject = extractFromProse([subject, block].join('\n'), '').roles ?? []
  const withoutSubject = extractFromProse(block, '').roles ?? []
  ok('件名を含めるとSEが漏れる（修正前の再現）', withSubject.includes('システムエンジニア'))
  ok('件名を外せばSEは付かない', !withoutSubject.includes('システムエンジニア'),
    `got ${JSON.stringify(withoutSubject)}`)
  // 本人のブロックに書かれている役割は残ること。
  // ※「サーバ 運用,」だけでは運用保守にならない（運用保守/運用管理/運用監視/保守運用が要る）のは
  //   意図した動作。工程の羅列を役割にしないための設計。
  ok('本人の役割は残る', withoutSubject.includes('ヘルプデスク'),
    `got ${JSON.stringify(withoutSubject)}`)
}
{
  const subject = '【弊社直人材】PMO/生保/小売/エネルギー/即日/95万～'
  const block = '【氏名】：T.K\n【年齢】：34歳\n【スキル】：Java, Spring Boot, AWS\n【対応工程】：詳細設計～テスト'
  const without = extractFromProse(block, '').roles ?? []
  ok('件名のPMOが本人に漏れない', !without.includes('PMO'), `got ${JSON.stringify(without)}`)
}

console.log(`\n合計: ${pass} 通過 / ${fail} 失敗`)
process.exit(fail === 0 ? 0 : 1)
