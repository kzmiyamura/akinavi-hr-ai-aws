#!/usr/bin/env node
// =============================================================================
// 人材メール解析の品質検証スクリプト（手動実行）
// =============================================================================
// 使い方:
//   node scripts/verify_email_extraction.mjs
//
// 内容:
//   実際の問題報告事例（バーソロジャパン笠井氏のメール＋添付スキルシート）に対し、
//   inbound-email Edge Function 内のヘルパーロジックを Node 環境にコピーして実行し、
//   修正後の抽出結果が想定通りであることを確認する。
// =============================================================================

// ─── inbound-email/index.ts と同じ実装（検証用に複製） ─────────────────────────

function stripUrlsForSkillMatching(text) {
  if (!text) return text
  return text.replace(/https?:\/\/[^\s\u3000<>"'\(\)\[\]｝】、，。]+/gi, ' ')
}

function stripSenderSignature(text) {
  if (!text) return text
  const lines = text.split(/\r?\n/)
  const separatorRe = /[━─=＝]{8,}/
  for (let i = 0; i < lines.length; i++) {
    if (separatorRe.test(lines[i])) {
      if (i / lines.length >= 0.5) {
        return lines.slice(0, i).join('\n')
      }
    }
  }
  return text
}

const STATION_TO_PREFECTURE = {
  '八街': '千葉県', '佐倉': '千葉県', '成東': '千葉県', '東金': '千葉県',
  '柏': '千葉県', '松戸': '千葉県', '市川': '千葉県', '船橋': '千葉県',
  '千葉': '千葉県',
  '大宮': '埼玉県', '浦和': '埼玉県',
  '横浜': '神奈川県', '川崎': '神奈川県', '町田': '神奈川県',
  '梅田': '大阪府', '難波': '大阪府',
  '名古屋': '愛知県',
  '札幌': '北海道', '仙台': '宮城県', '博多': '福岡県',
}

function inferPrefectureFromStation(station) {
  if (!station) return null
  const cleaned = station.replace(/駅$/, '').replace(/\s+/g, '').trim()
  if (!cleaned) return null
  return STATION_TO_PREFECTURE[cleaned] ?? null
}

const STRICT_PHASE_HEADER_KEYWORDS = [
  '調査分析', '要件定義', '基本設計', '詳細設計',
  '単体試験', '結合試験', '総合試験', '運用試験', '受入試験',
  '単体テスト', '結合テスト', '総合テスト', '受入テスト',
]

function isPhaseTableHeader(line) {
  if (!line) return false
  let count = 0
  for (const kw of STRICT_PHASE_HEADER_KEYWORDS) {
    if (line.includes(kw)) {
      count++
      if (count >= 4) return true
    }
  }
  return false
}

const PROSE_ROLES = [
  { re: /PM|プロジェクト[　 ]?マネージャー/,           label: 'プロジェクトマネージャー' },
  { re: /PL|プロジェクト[　 ]?リーダー/,               label: 'プロジェクトリーダー' },
  { re: /TL|テックリード|テック[　 ]?リード/,           label: 'テックリード' },
  { re: /(?<![バックエンドフロントクラウドデータML])SE(?![A-Z])|システム[　 ]?エンジニア(?!長)/, label: 'システムエンジニア' },
  { re: /PG|プログラマー?/,                            label: 'プログラマー' },
  { re: /インフラ[　 ]?エンジニア/,                    label: 'インフラエンジニア' },
  { re: /フロントエンド[　 ]?エンジニア|フロント[　 ]?エンジニア/, label: 'フロントエンドエンジニア' },
  { re: /バックエンド[　 ]?エンジニア|バック[　 ]?エンジニア/,    label: 'バックエンドエンジニア' },
  { re: /フルスタック[　 ]?エンジニア/,                label: 'フルスタックエンジニア' },
  { re: /クラウド[　 ]?エンジニア/,                    label: 'クラウドエンジニア' },
  { re: /データ[　 ]?エンジニア/,                      label: 'データエンジニア' },
  { re: /MLエンジニア|機械学習[　 ]?エンジニア/,       label: 'MLエンジニア' },
  { re: /スクラム[　 ]?マスター/,                      label: 'スクラムマスター' },
  { re: /アーキテクト/,                                label: 'アーキテクト' },
  { re: /コンサルタント/,                              label: 'コンサルタント' },
  { re: /要件定義/,                                    label: '要件定義' },
  { re: /基本設計/,                                    label: '基本設計' },
  { re: /詳細設計/,                                    label: '詳細設計' },
  { re: /テスト[　 ]?(?:リード|エンジニア|設計)/,      label: 'テストエンジニア' },
  { re: /運用[　 ]?(?:保守|管理)/,                     label: '運用保守' },
]

const PROSE_INDUSTRIES = [
  { re: /金融機関|銀行|証券|保険会社|生命?保険|損害?保険|信用金庫|信託銀行|FinTech|フィンテック|金融業界|金融系/, label: '金融' },
  { re: /医療機関|ヘルスケア|病院|クリニック|製薬|医薬品|MedTech|医療業界/, label: '医療・ヘルスケア' },
  { re: /製造業|メーカー(?!ロゴ)|プラント|工場(?!勤務|常駐|地域|長)|IoT分野|FAシステム|自動車業界|電気業界|電機メーカー|製造業界/, label: '製造' },
  { re: /(?:^|[^A-Z])EC(?![A-Z])|イーコマース|eコマース|電子商取引|物流(?!倉庫担当)|運送業|商社/, label: 'EC・物流' },
  { re: /小売(?:業)?|流通(?:業)?|リテール|百貨店|スーパー|コンビニ/, label: '小売・流通' },
  { re: /通信(?:業|会社|キャリア|機器)?|テレコム|キャリア(?![,\sア-ン])/, label: '通信' },
  { re: /ゲーム業界|エンタメ|エンターテインメント|メディア業界|動画配信|配信プラットフォーム/, label: 'ゲーム・エンタメ' },
  { re: /不動産|建設|住宅|プロパティ|デベロッパー/, label: '不動産・建設' },
  { re: /官公庁|自治体|公共(?!IT)|行政|省庁|外務省|区役所|市役所|県庁|地方公共団体/, label: '公共・官公庁' },
  { re: /教育機関|学校法人|塾|EdTech|eLearning|教育業界|学校教育|大学|高校|専門学校/, label: '教育' },
  { re: /SES(?![A-Z])|受託(?:開発)?|SI(?!P|[A-Z])|システムインテグレーション/, label: 'SES・SI' },
  { re: /スタートアップ|ベンチャー(?:企業)?/, label: 'スタートアップ' },
  { re: /人材(?:業界|業)|HR(?![A-Z]|テスト)|HRTech|採用(?:業務|プラットフォーム|マーケット)/, label: '人材・HR' },
  { re: /マーケ(?:ティング)?(?:業界|職)?|広告(?:代理店|業界)?|デジタルマーケ/, label: 'マーケティング' },
]

function extractFromProse(bodyText, attachText) {
  const cleanedBody = stripUrlsForSkillMatching(bodyText)
  const cleanedAttach = stripUrlsForSkillMatching(attachText)
  const allText = cleanedBody + '\n' + cleanedAttach

  const proseLines = allText.split(/\r?\n/).filter(
    l => (l.length > 20 || /[、。]/.test(l)) && !isPhaseTableHeader(l),
  )
  const prose = proseLines.join('\n')

  const roles = []
  if (prose.trim()) {
    for (const { re, label } of PROSE_ROLES) {
      if (re.test(prose) && !roles.includes(label)) roles.push(label)
    }
  }

  const industryScanText = allText.split(/\r?\n/).filter(l => !isPhaseTableHeader(l)).join('\n')
  const industries = []
  for (const { re, label } of PROSE_INDUSTRIES) {
    if (re.test(industryScanText) && !industries.includes(label)) industries.push(label)
  }

  return { roles, industries }
}

// ─── 検証用テストケース ────────────────────────────────────────────────────

const SUBJECT = '☆【6月～/経験13年/インフラエンジニア/JP1】技術者のご提案をさせていただきます。'
const FROM = 'kasai@bartholojapan.jp'
const BODY = `ご担当者様
　（失礼ながらBcc送信でご連絡させて頂いております。）

いつも大変お世話になっております、バーソロジャパン笠井でございます。

早速ですが技術者のご提案をさせて頂きます。
見合う案件が有りましたらご紹介いただけますと幸いです。
―――――――――――――――

名前：KT　38歳　男性
最寄：JR総武本線　八街駅

所属：弊社1社下社員
単価：68万円
稼働：6月～

【工程】(詳細設計)/ 構築 / テスト / 運用 / システム移行 / 運用保守 / 障害対応
【スキル】JP1 / Tere Term / Windows Server / Linux Server /
　　　　　SQL Server / PostgleSQL / Oracle / SQL / AWS /
　　　　　Shell(bash) / Zabbix 他
【資格】上級情報処理士 / ITパスポート 他

経験：13年3ヶ月

希望：
・通勤90分以内（乗り換え2回まで）
【NG】
・24/365
・定常的な夜勤（稀なものや、土日のシフトは応相談）

並行：提案のみ。
備考：
経験年数は13年3ヶ月に及び 、特にシステムの安定稼働を支える運用・保守・監視の領域で非常に高い専門性を持っています。
JP1 (AJS3/IM-View)、Zabbix、Hinemos、Tivoli といった業界標準の運用管理・監視ツールを実務で使いこなしています 。
監視・運用業務から 、障害対応、アラート調査 、さらには運用設計やジョブネット作成まで、下流から上流までの運用実務を網羅しています 。

直近では、既存システムからクラウド環境への移行プロジェクトにおいて、
AWS環境への移行手順書の作成や、オンプレミスからクラウドへのファイル移行実務を担当しています 。
移行リハーサルや本番対応、移行前の影響調査、現新比較テストなど、システム更改に伴うリスクを最小化するための検証・実行プロセスを熟知しています 。

ドキュメント作成面では、移行手順書、詳細設計書の修正、テスト仕様書、稼働統計レポートなど、多岐にわたる資料作成経験が豊富です 。
メンバーの他にも、直近ではサブリーダーの役割で動いておりました。
また、過去にはリーダー経験もあり、縁の下の力持ちとしてPJを支えます。
家が少し遠いですが、今までも2時間近く掛けて常駐していたため
通勤面は心配ございません。
――――――――――――――――――――――――――――――

以上です、よろしくお願いいたします。

━━━━━━━━━━━━━━━━━━━━■

株式会社Bartholo Japan 　笠井　聡
〒194-0022 東京都町田市森野1-11-16 渋谷第一ビル2階

■MAIL‥‥ kasai@bartholojapan.jp
■TEL ‥‥ 042-732-6670
■FAX ‥‥ 042-732-6671
■URL ‥‥ https://a24.hm-f.jp/cc.php?t=M446278&c=6503&d=b40d

┗━━━━━━━━━━━━━━━━━━━━■`

const ATTACH_TEXT = `氏名 KT
性別 男 最寄 八街駅 年齢 38 経験年数 13 年 3 ヶ月
取得資格 コンピューターサービス技能評価表計算部門3級,パソコン検定協会主催Ｐ検3級,上級情報処理士,ビジネス実務,ITパスポート

スキル
●OS・クラウド
Windows7,8,10,11、Windows Vista、WindowsXP
Windows Server2008,2012,2012R2,2016
Linux
AWS

●言語
JAVA、JavaScript、shell(bash)、SQL、COBOL、Visual Basic、XML

●DB
Windows Server、Linux Server
SQL Server、PostgreSQL、Oracle

●ツール・利用製品等
JP1(AJS3/IM-View)、Hinemos、Tivoli、Zabbix
Teraterm、Eclipse(DBViewer)、FTP
Word、Excel、PowerPoint、Teams、Notes、Resso

No 期間 ユーザー/業種 プロジェクト名 規模/役割 機種OS DB 言語 ツール フェーズ・備考
調査分析	要件定義	基本設計	詳細設計	製造/構築	単体試験	総合試験	運用試験	保守/運用
1 2026/1/1 機器更改 15人/M Windows11 Linux AWS JP1 TeraTerm Word Excel ●  ●  ●
・移行手順書作成
・移行リハ、移行本番対応
・ファイル移行(オンプレ→クラウド)

2 2025/8/1 某保険会社 ポータルサイト保守・移行 15人/M Windows11 Linux JP1 Teraterm Word Excel ●  ●  ●
・移行手順書作成
・障害対応(アラート調査など)

7 2020/10/1 某出版社 システム運用 6人/M(～2021/3) Windows10 Windows Server 2012、2016 oracle Teraterm Word Excel PowerPoint Zabbix
・エンドユーザーのシステム運用巻き取り
・運用改善活動

10 2018/10/1 某通信機器 携帯キャリアの構成管理 25人/M Windows7 Windows10 SQL Excel Teraterm Eclipse(DBViewer)
・リリース資産の申請対応
・夕会の司会、進行
・新人教育

15 2015/5/1 官公庁 電子申告・納税システム 30人/M Windows7 JAVA XML
・帳票のレイアウト作成、テスト、修正

17 2014/7/1 社内 研修 Windows7 Windows Server SQL JAVA COBOL Visual Basic
・新入社員基礎研修
・ビジネスマナー研修
・ITパスポート研修
・フローチャートの基礎知識
・COBOL、VB、Java言語(プログラム製造～単体テスト)

18 2013/6/1 外務省 入国管理システム Windows7 Linux SQL FTP JP1
・24時間365日の監視業務
`

console.log('========================================')
console.log('品質検証: バーソロジャパン笠井氏のメール')
console.log('========================================\n')

// ─── 検証1: URL ストリッピング ─────────────────────────
console.log('【検証1】URL ストリッピング')
const urlText = '【URL】https://a24.hm-f.jp/cc.php?t=M446278&c=6503&d=b40d'
const stripped = stripUrlsForSkillMatching(urlText)
console.log(`  入力: "${urlText}"`)
console.log(`  出力: "${stripped}"`)
console.log(`  期待: URL 部分が除去され "cc.php" が含まれない`)
console.log(`  結果: ${stripped.includes('.php') ? '❌ FAIL（.php がまだ残っている）' : '✅ PASS'}\n`)

// ─── 検証2: 送信者署名の除去 ───────────────────────────
console.log('【検証2】送信者署名の除去（〒東京都町田市の誤判定防止）')
const sigStripped = stripSenderSignature(BODY)
const stillHasTokyo = sigStripped.includes('東京都')
console.log(`  期待: 署名以降の "東京都町田市" が除去されている`)
console.log(`  結果: ${stillHasTokyo ? '❌ FAIL（東京都がまだ残っている）' : '✅ PASS'}\n`)

// ─── 検証3: 駅→都道府県マッピング ──────────────────────
console.log('【検証3】八街駅 → 千葉県の推定')
const yachimataPref = inferPrefectureFromStation('八街駅')
console.log(`  入力: "八街駅"`)
console.log(`  出力: "${yachimataPref}"`)
console.log(`  期待: "千葉県"`)
console.log(`  結果: ${yachimataPref === '千葉県' ? '✅ PASS' : '❌ FAIL'}\n`)

// ─── 検証4: フェーズ表ヘッダー検出 ──────────────────────
console.log('【検証4】フェーズ表ヘッダー行の検出')
const phaseHeader = '調査分析	要件定義	基本設計	詳細設計	製造/構築	単体試験	総合試験	運用試験	保守/運用'
const bodyKoTei = '【工程】(詳細設計)/ 構築 / テスト / 運用 / システム移行 / 運用保守 / 障害対応'
const isPhase1 = isPhaseTableHeader(phaseHeader)
const isPhase2 = isPhaseTableHeader(bodyKoTei)
console.log(`  フェーズ表ヘッダー行 → ${isPhase1 ? '✅ ヘッダーと判定（正）' : '❌ FAIL（ヘッダーと判定されない）'}`)
console.log(`  本文の【工程】行   → ${isPhase2 ? '❌ FAIL（ヘッダーと誤判定）' : '✅ ヘッダーではないと判定（正）'}\n`)

// ─── 検証5: 役割・業界の抽出（メイン） ──────────────────
// 実際の Edge Function は subject + body + 添付名 を bodyText として extractFromProse に渡す
console.log('【検証5】役割・業界の抽出（PROSE_ROLES / PROSE_INDUSTRIES）')
const result = extractFromProse(SUBJECT + '\n' + BODY, ATTACH_TEXT)

console.log('\n■役割')
console.log(`  抽出結果: ${JSON.stringify(result.roles)}`)
const expectedRoles = ['インフラエンジニア', '詳細設計', '運用保守']
const unwantedRoles = ['要件定義', '基本設計']
for (const r of expectedRoles) {
  console.log(`    "${r}" が含まれる: ${result.roles.includes(r) ? '✅' : '❌'}`)
}
for (const r of unwantedRoles) {
  console.log(`    "${r}" が含まれない: ${!result.roles.includes(r) ? '✅' : '❌（false positive 残）'}`)
}

console.log('\n■業界')
console.log(`  抽出結果: ${JSON.stringify(result.industries)}`)
const expectedInd = ['金融', '通信', '公共・官公庁', 'EC・物流']
const unwantedInd = ['製造', '教育']
for (const r of expectedInd) {
  console.log(`    "${r}" が含まれる: ${result.industries.includes(r) ? '✅' : '⚠️（添付次第）'}`)
}
for (const r of unwantedInd) {
  console.log(`    "${r}" が含まれない: ${!result.industries.includes(r) ? '✅' : '❌（false positive 残）'}`)
}

// ─── 検証6: 都道府県判定（駅由来優先） ──────────────────
console.log('\n【検証6】都道府県判定（送信者署名の "東京都" を駅で上書き）')
const PREFECTURES = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県']

const fullText = SUBJECT + '\n' + BODY + '\n' + ATTACH_TEXT
const fullTextStripped = stripSenderSignature(SUBJECT + '\n' + BODY) + '\n' + ATTACH_TEXT
let prefBefore = PREFECTURES.find(p => fullText.includes(p)) ?? null
let prefAfterStrip = PREFECTURES.find(p => fullTextStripped.includes(p)) ?? null
const prefFromStation = inferPrefectureFromStation('八街駅')
let final = prefAfterStrip
if (prefFromStation) final = prefFromStation

console.log(`  ① 全文検索（修正前）: ${prefBefore}`)
console.log(`  ② 署名除去後検索   : ${prefAfterStrip}`)
console.log(`  ③ 駅由来推定       : ${prefFromStation}`)
console.log(`  ④ 最終確定         : ${final}`)
console.log(`  期待: "千葉県"`)
console.log(`  結果: ${final === '千葉県' ? '✅ PASS' : '❌ FAIL'}\n`)

console.log('========================================')
console.log('全テスト完了')
console.log('========================================')
