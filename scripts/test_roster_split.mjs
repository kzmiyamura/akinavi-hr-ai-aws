#!/usr/bin/env node
// 名簿メールの分割と、件名からの役割漏れの回帰テスト。
// 本物の splitMultiCandidateBody / extractFromProse を使う（手写しのレプリカにしない）。
//
// 使い方: node scripts/test_roster_split.mjs
import { splitMultiCandidateBody, extractFromProse, extractNameFallback } from './_extractors.gen.mjs'

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

console.log('\n=== 行頭の連番で人を並べる名簿（区切り線が無い形式）===')
// 2026-10-20 実測: マクロシステムの「要員4名」メールが**1行に潰れていた**。
// 画面には「氏名未取得」と出て、スキルは4人ぶんの合算（C/Ruby/COBOL/Delphi…）になり、
// マッチングでは何にでも当たる行になっていた。
// 区切り線は「＜即～＞ーーーー…」のように前置きが付くため ^[ー]{8,} に当たらず、
// 人の境目は「1．ＢＢＫ（最寄駅：…）」という**行頭の連番見出し**だけだった。
const MACRO_BODY = [
  'お世話になっております、マクロシステムの尾崎です。',
  'この度は、下記要員をご紹介致します。',
  '',
  '＜即～＞ーーーーーーーーーーーーーーーーーーーーーーーーーーーー',
  '',
  '1．ＢＢＫ（最寄駅：JR総武線・津田沼駅）',
  '　１）年齢　　：50歳（女性）',
  '　２）稼動時期：即～',
  '　３）スキル　：・Ruby、JavaScript、Vue.js、HTML、PHP',
  '　　　　　　　・MySQL、PostgreSQL',
  '　４）希望単金：550千円/月（応相談）',
  '',
  '2．ＹＹＫ（最寄駅：JR京浜東北線・南浦和駅）',
  '　１）年齢　　：54歳（男性）',
  '　２）稼動時期：即～',
  '　３）スキル　：・C、Pro＊C、C++、シェル、PL/SQL',
  '　４）希望単金：550千円/月（応相談）',
  '',
  '＜11/1～＞ーーーーーーーーーーーーーーーーーーーーーーーーーー',
  '',
  '3．ＭＵＹ（最寄駅：西武新宿線・小平駅）',
  '　１）年齢　　：37歳（女性）',
  '　２）稼動時期：11/1～',
  '　３）スキル　：・ヘルプデスク、PCキッティング、JavaScript、Access',
  '　４）希望単金：450千円/月（応相談）',
  '',
  '4．ＳＫＴ（最寄駅：京王線・初台駅）',
  '　１）年齢　　：55歳（男性）',
  '　２）稼動時期：11/1～',
  '　３）スキル　：・VB、ExcelVBA、Java、COBOL、Delphi',
  '　４）希望単金：580千円/月（応相談）',
  '',
  '株式会社マクロシステム 営業部 尾崎雅彦',
].join('\n')
{
  const blocks = splitMultiCandidateBody(MACRO_BODY)
  ok('連番名簿を4人に分割する', (blocks?.length ?? 0) === 4, `got ${blocks?.length ?? 'null'}`)
  ok('1人目の氏名が取れる', extractNameFallback(blocks?.[0] ?? '') === 'BBK',
    `got ${JSON.stringify(extractNameFallback(blocks?.[0] ?? ''))}`)
  ok('4人目のブロックに他人のスキルが混ざらない',
    !!blocks?.[3]?.includes('COBOL') && !blocks?.[3]?.includes('Ruby'),
    `got ${JSON.stringify(blocks?.[3]?.slice(0, 60))}`)
}
// ⚠ 連番の見出しは「アピールの箇条書き」にも使われる。本番の4通のうち**3通は1人**で、
//    素朴に連番で切ると1人が3つに割れる（2026-10-20 実測）。
//    人の見出しとみなすのは「連番＋短い氏名＋（最寄駅/歳/性別）」の形だけ。
{
  const body = [
    'お世話になっております。弊社エンジニアをご紹介いたします。',
    '【氏名】K.S',
    '【年齢】42歳',
    '1. 炎上・遅延案件を確実に完遂させるPM/リカバリー推進力',
    '　複数PJの立て直し実績があります。',
    '2. 上流～実装・インフラまでワンストップ対応（エンジニア歴18年）',
    '　要件定義から運用までを一人称で回せます。',
    '3. チームの開発力を引き上げる「AI駆動開発」とモダン化の実践力',
    '　希望単価：90万円',
  ].join('\n')
  const blocks = splitMultiCandidateBody(body)
  ok('アピールの箇条書きでは分割しない', blocks === null || blocks.length <= 1,
    `got ${blocks?.length ?? 'null'}`)
}
{
  const body = [
    'いつもお世話になっております。下記の通りご紹介いたします。',
    '１．ディレクションやPMOなど',
    '　稼働時期：即～　希望単価：70万',
    '２．Webフロントエンド開発系やアプリ開発系など',
    '　稼働時期：11月～　希望単価：65万',
  ].join('\n')
  const blocks = splitMultiCandidateBody(body)
  ok('カテゴリ見出しでは分割しない', blocks === null || blocks.length <= 1,
    `got ${blocks?.length ?? 'null'}`)
}
{
  // 「1．Java（5年）」のような技術の列挙を氏名にしない
  const line = '1．Java（5年）\n2．Python（3年）'
  ok('技術名の連番を氏名にしない', extractNameFallback(line) !== 'Java',
    `got ${JSON.stringify(extractNameFallback(line))}`)
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
