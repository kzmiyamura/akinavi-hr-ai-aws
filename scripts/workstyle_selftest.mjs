#!/usr/bin/env node
// workstyle_selftest.mjs — 勤務形態(workStyleNote)抽出の単体テスト
//
// 勤務条件は営業がメール本文で述べるもの。経歴書には案件の業務内容として
// 「取引先に常駐し…」等が頻出し、それは本人の勤務条件ではない。
// 実害(2026-08-10): KH さんの勤務形態に、経歴書にある23年前の案件の業務内容
// 「取引先に常駐し小規模案件のメンテナンスが中心」が入っていた。
//
// 実行: node scripts/workstyle_selftest.mjs
import { extractWorkStyleNote } from './_extractors.gen.mjs'

let pass = 0, fail = 0
const t = (label, got, expect) => {
  if (got === expect) pass++
  else { fail++; console.log(`  FAIL ${label}\n    got=${JSON.stringify(got)}\n    exp=${JSON.stringify(expect)}`) }
}

// ── 本文の記載は拾う ──
// ラベル（「勤務：」等）は既存仕様でそのまま残す。人が読む生の条件文が目的のため
t('本文の勤務条件を拾う',
  extractWorkStyleNote('氏名：A.B\n勤務：フルリモート希望\n単価：60万', ''), '勤務：フルリモート希望')
t('本文の常駐可を拾う',
  extractWorkStyleNote('所属：弊社正社員\n常駐可\n単価：60万', ''), '常駐可')

// ── 経歴書の案件説明は拾わない（今回の修正の核心）──
// KH さんの実データそのもの
const khResume = [
  '2000年7月～\n2003年4月',
  '損保 損益管理及び決済系システム構築 、計上及び更改系システム構築',
  '・上記システムにおける新商品の開発及びメンテナンス',
  '・取引先に常駐し小規模案件のメンテナンスが中心。',
  'ＩＢＭ\nMVS\nCOBOL',
].join('\n')
t('経歴書の案件説明は勤務形態にしない（KH実データ）',
  extractWorkStyleNote('氏名：KH 男性 58歳\n所属：弊社グループ会社契約社員\n単価：60万円', khResume), null)

t('経歴書の「取引先に常駐し、詳細設計～総合テストまでを担当」も拾わない',
  extractWorkStyleNote('', '・取引先に常駐し、詳細設計～総合テストまでを担当。'), null)
t('経歴書の「客先常駐で開発を担当」も拾わない',
  extractWorkStyleNote('', '客先常駐で基幹システムの開発を担当'), null)

// ── 本文に記載があれば、経歴書の案件説明より本文が優先される ──
t('本文優先（経歴書に紛らわしい記述があっても本文を採る）',
  extractWorkStyleNote('フルリモート希望です', '・取引先に常駐し開発を担当'), 'フルリモート希望です')

// ── 経歴書側でも、案件説明でない素の条件は拾ってよい ──
t('経歴書の備考欄の条件は拾う',
  extractWorkStyleNote('', '【備考】\n週2出社可'), '週2出社可')

// ── 営業の見出し・件名は勤務条件ではない ──
// bodyText は「件名＋本文」で構成されるため、件名がそのまま候補に上がってくる。
// 勤務条件は一人について述べるものなので、人数や紹介文言を含む行は該当しない。
// 実害: 件名がそのまま勤務形態に入っていた（S.K・フォスターネット・2026-08-10）
const skSubject = [
  '【常駐いけます！】出社可能なエンジニア18名をご紹介！【フォスターネット】',
  '氏名：S.K',
  '単価：130万円',
].join('\n')
t('件名の営業見出しを拾わない（S.K実データ）', extractWorkStyleNote(skSubject, ''), null)
t('人数を含む行は拾わない', extractWorkStyleNote('常駐可能なエンジニア5名', ''), null)
t('紹介文言を含む行は拾わない', extractWorkStyleNote('フルリモート対応の要員をご紹介します', ''), null)
t('人数を含まない素の条件は従来どおり拾う',
  extractWorkStyleNote(['氏名：A.B', '常駐可'].join('\n'), ''), '常駐可')

// ── 行全体が括弧で囲まれた見出しは拾わない ──
// 実害: 本文の見出し「《セキュリティ・NW／リモート併用》」が勤務形態に入っていた（T.N・2026-08-11）
t('括弧で囲まれた見出しを拾わない（T.N実データ）',
  extractWorkStyleNote('《セキュリティ・NW／リモート併用》', ''), null)
t('ラベル付きの値は従来どおり拾う（閉じ括弧で終わらない）',
  extractWorkStyleNote('【所属】常駐可', ''), '所属常駐可')

// ── 既存の除外ルールが壊れていないこと ──
t('人物評は拾わない',
  extractWorkStyleNote('リモート環境でも自発的にコミュニケーションが取れます', ''), null)
t('件名装飾は拾わない',
  extractWorkStyleNote('★要員即日／PMO／経験7年／フルリモート可／即日', ''), null)
t('最寄駅の行は拾わない',
  extractWorkStyleNote('最寄：新宿駅（常駐可）', ''), null)

console.log(`\n📊 ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
