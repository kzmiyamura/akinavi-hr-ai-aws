#!/usr/bin/env node
// =============================================================================
// 役割（roles）・業界（industries）の抽出品質テスト
// =============================================================================
// 使い方: node scripts/test_prose_roles_industries.mjs
//
// 2026-08-21 の総点検で見つかった誤検出を固定する。
// prod 2,077人での実測（修正前）:
//   教育       824人 → 684人(83%)は学歴欄の「大学」だけが根拠
//   通信       840人 → 548人(65%)は裸の「通信」だけ
//   人材・HR    85人 →  78人(92%)は裸の「HR」だけ
//   システムエンジニア 614人 → 72人は DATABASE 等の英単語末尾 SE だけ
//   プログラマー      385人 → 92人は JPG/PNG/MPG だけ
//
// index.ts から自動生成された _extractors.gen.mjs を読むので本番と食い違わない。
// =============================================================================
import { extractFromProse, INDUSTRY_MAX } from './_extractors.gen.mjs'

const roles = (body) => extractFromProse(body, '').roles
const inds = (body) => extractFromProse(body, '').industries

let passed = 0, failed = 0
const ok = (label, cond, detail) => {
  if (cond) { passed++; return }
  failed++
  console.log(`❌ ${label}${detail ? `\n   ${detail}` : ''}`)
}
const hasNot = (label, body, fn, word) => {
  const got = fn(body)
  ok(label, !got.includes(word), `got ${JSON.stringify(got)} — ${word} が付いてはいけない`)
}
const has = (label, body, fn, word) => {
  const got = fn(body)
  ok(label, got.includes(word), `got ${JSON.stringify(got)} — ${word} が付くべき`)
}

console.log('── 業界: 学歴欄・一般語で誤発火しないこと ──')
hasNot('学歴の「大学」で教育業界にしない', '学歴：明治学院大学大学院 経済学研究科を卒業しました。', inds, '教育')
hasNot('「高校」も同様', '最終学歴：私立〇〇高校を卒業しています。', inds, '教育')
hasNot('裸の「通信」で通信業界にしない', 'NWインフラの要件定義・設計・構築を担当し、通信プロトコルの設定変更を行いました。', inds, '通信')
hasNot('「キャリアパス」で通信業界にしない', '後進育成としてキャリアパスの設計、キャリアシートのレビューを実施しました。', inds, '通信')
hasNot('裸の「公共」で官公庁にしない', '公共施設の予約システムに近い画面を、公共交通の案内画面として作りました。', inds, '公共・官公庁')
hasNot('「住宅ローン」で不動産・建設にしない', '住宅ローンの審査システムの開発を担当していました。', inds, '不動産・建設')
hasNot('裸の「メーカー」で製造にしない', 'メーカー向けのサポート窓口業務を長く担当しておりました。', inds, '製造')
hasNot('裸の「広告」でマーケティングにしない', '広告表示部分のフロント改修を担当しました。', inds, 'マーケティング')
hasNot('裸の「HR」で人材・HRにしない', 'HRという略称のバッチ処理を改修しました。', inds, '人材・HR')

console.log('── 業界: 本物は取れること ──')
has('教育機関', '学校法人向けの教育機関システムを構築しました。', inds, '教育')
has('通信キャリア', '通信キャリア向けの課金システムを担当し、通信業界に長く在籍しました。', inds, '通信')
has('官公庁', '官公庁の案件で、自治体向けの行政システムを担当しました。', inds, '公共・官公庁')
has('金融', '銀行の勘定系システムで、証券会社向けの開発も経験しました。', inds, '金融')
has('製造(複合語)', '自動車メーカー向けの生産管理システムを担当しました。', inds, '製造')
has('不動産', '不動産のポータルサイト開発、ゼネコンの原価管理を担当しました。', inds, '不動産・建設')

console.log('── 業界: 出現回数の多い順・上限 ──')
{
  // 金融を何度も書き、他業界は1回だけ → 金融が先頭に来る
  const body = [
    '銀行の勘定系を担当しました。信用金庫の案件、証券会社の案件、保険会社の案件も経験。金融業界が長いです。',
    '官公庁の案件も1件だけあります。',
    '不動産のシステムも1件だけあります。',
  ].join('\n')
  const got = inds(body)
  ok('回数が多い業界が先頭', got[0] === '金融', `got ${JSON.stringify(got)}`)
  ok(`上限 ${INDUSTRY_MAX} 件`, got.length <= INDUSTRY_MAX, `got ${got.length}件`)
}
{
  // 全業界に触れる長文でも上限で止まる
  const body = [
    '銀行と証券会社の案件を担当しました。',
    '病院の電子カルテを担当しました。',
    '自動車メーカーの生産管理システムを担当しました。',
    '物流の倉庫管理システムを担当しました。',
    '小売業のPOSシステムを担当しました。',
    '通信キャリアの課金システムを担当しました。',
    '官公庁の案件を担当しました。',
  ].join('\n')
  ok(`多業界でも ${INDUSTRY_MAX} 件で打ち切る`, inds(body).length === INDUSTRY_MAX, `got ${JSON.stringify(inds(body))}`)
}

console.log('── 役割: 英単語に埋もれた略称で誤発火しないこと ──')
hasNot('DATABASE の SE', 'ORACLE DATABASE の設計と構築を長く担当してきました。', roles, 'システムエンジニア')
hasNot('LICENSE / RESPONSE の SE', 'LICENSE 管理と RESPONSE 解析のツールを作成しました。', roles, 'システムエンジニア')
hasNot('JPG / PNG の PG', '画像は JPG と PNG に変換して保存する処理を実装しました。', roles, 'プログラマー')

console.log('── 役割: 本物は取れること ──')
has('SE 単独', '役割：SE として要件定義から参画しました。', roles, 'システムエンジニア')
has('システムエンジニア', 'システムエンジニアとして10年の経験があります。', roles, 'システムエンジニア')
has('PG 単独', '役割：PG として実装を担当しました。', roles, 'プログラマー')
has('PMO', 'PM/PMOとして開発チームをマネジメントしていました。', roles, 'PMO')
has('バックエンドSEは別役割へ', 'バックエンドエンジニアとして開発を担当しました。', roles, 'バックエンドエンジニア')

console.log(`\n📊 ${passed} passed / ${failed} failed`)
process.exit(failed ? 1 : 0)
