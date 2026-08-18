#!/usr/bin/env node
// test_agent_solicitation.mjs — 営業定型文の除去と、役割抽出への影響を固定する（2026-08-17）
//
// 実害: ai・more のメールに毎回入る
//   「以下要員以外にも多数 開発、テスター、インフラ(…)、ヘルプデスク,キッティング等
//     エンジニアがおりますので案件を頂けますと幸いです。」
// を本人の役割として拾い、1人だけのメールで「ヘルプデスク」等が付いていた。
//
// 実行: node scripts/test_agent_solicitation.mjs
import { stripAgentSolicitation, scoreProseRoles } from './_extractors.gen.mjs'

let pass = 0, fail = 0
const t = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}\n     期待: ${JSON.stringify(expected)}\n     実際: ${JSON.stringify(actual)}`) }
}

// 実メール（ai・more）とほぼ同じ形
const REAL = `株式会社ボイス
ご担当者様

いつもお世話になっております。
朝倉でございます。
下記要員に見合います案件ございましたら宜しくお願い致します。

※※※※※※※※
以下要員以外にも多数
開発、テスター、インフラ(SV,NW運用監視～構築設計)、ヘルプデスク,キッティング等
エンジニアがおりますので案件を頂けますと幸いです。
※※※※※※※※

■氏名：R.I
■最寄駅：所沢

【サマリー】
要件定義から設計、開発支援、品質管理まで対応可能なシニアエンジニアです。
DWH／ETLのデータ基盤領域に経験があり、SQLを用いた影響調査を強みとしております。`

const stripped = stripAgentSolicitation(REAL)

t('宣伝文の「ヘルプデスク」が消える', /ヘルプデスク/.test(stripped), false)
t('宣伝文の「テスター」が消える', /テスター/.test(stripped), false)
t('本人の記述は残る', /DWH／ETL/.test(stripped), true)
t('宛先行は残る（会社名判定は別処理の担当）', /株式会社ボイス/.test(stripped), true)
t('氏名行は残る', /■氏名：R.I/.test(stripped), true)

// 役割抽出まで通したときの差
const rolesBefore = scoreProseRoles(REAL, REAL).roles
const rolesAfter = scoreProseRoles(stripped, stripped).roles
console.log(`  参考: 除去前の役割 [${rolesBefore.join(', ')}] → 除去後 [${rolesAfter.join(', ')}]`)
t('除去後の役割にヘルプデスクが入らない', rolesAfter.includes('ヘルプデスク'), false)

// 巻き込み防止: 本人の文に「以外にも」が出てくるだけなら消しすぎない
const OWN = `本人は業務システム以外にも、Webアプリの開発経験があります。
運用保守を5年担当し、障害対応の一次切り分けまで行っていました。`
const ownStripped = stripAgentSolicitation(OWN)
t('本人の文の「以外にも」で運用保守まで消さない', /運用保守/.test(ownStripped), true)

// 別表現
const ALT = `他にも多数エンジニアがおりますのでご相談ください。

■氏名：T.K
運用保守を担当。`
t('「他にも多数」形式も落ちる', /ご相談ください/.test(stripAgentSolicitation(ALT)), false)
t('その後の本人記述は残る', /運用保守を担当/.test(stripAgentSolicitation(ALT)), true)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exitCode = fail === 0 ? 0 : 1
