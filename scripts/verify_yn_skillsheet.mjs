#!/usr/bin/env node
/**
 * YN（32歳・男性・1993/10/26生・小田急江ノ島線 六会日大前駅）スキルシート解析品質チェック
 *
 * 直近本体 (supabase/functions/inbound-email/index.ts) のヘルパーを正確に複製して実行。
 * 本体側で既に修正済みのものは ✅ になる。残った ❌ が修正対象。
 */

// ──────────────────────────────────────────────────────────────
// inbound-email/index.ts と同じ実装（最新版を複製）
// ──────────────────────────────────────────────────────────────

function stripUrlsForSkillMatching(text) {
  if (!text) return text
  return text.replace(/https?:\/\/[^\s\u3000<>"'\(\)\[\]｝】、，。]+/gi, ' ')
}

function flexLabel(label) {
  const META = /[.*+?()[\]{}\\|^$]/
  let result = ''
  for (let i = 0; i < label.length; i++) {
    const ch = label[i]
    const isMeta = META.test(ch)
    result += isMeta ? ch : ch.replace(/[.*+?()[\]{}\\|^$]/g, '\\$&')
    if (i < label.length - 1) {
      const nextIsMeta = META.test(label[i + 1])
      if (!nextIsMeta) result += '[　 ]*'
    }
  }
  return result
}

function extractFieldTwoPhase(labels, bodyText, attachText, validate, maxLen = 30, phase3MinLen = 3) {
  const esc = labels.map(flexLabel).join('|')
  const SEP = `(?:[：:\\t】]|　+| {2,})`
  const SEP_ATT = `(?:[：:\\t,，】]|　+| {2,})`
  const check = (v, minLen = 1) => {
    const t = v.trim().replace(/[　 ]+$/, '')
    if (!t || t.length < minLen || t.length > maxLen) return null
    if (validate && !validate(t)) return null
    return t
  }
  const rSameLine = (sep) => new RegExp(`(?:${esc})[　 ]?${sep}[　 ]?([^\\n,，]{1,${maxLen}})`, 'i')
  const bodyBlocks = bodyText.split(/\n{2,}/)
  if (bodyBlocks.length > 1) {
    const labelPresent = new RegExp(`(?:${esc})`, 'i')
    const block = bodyBlocks.find(b => labelPresent.test(b))
    if (block && block !== bodyText) {
      const m = block.match(rSameLine(SEP))
      if (m) { const v = check(m[1]); if (v) return v }
    }
  }
  const mBody = bodyText.match(rSameLine(SEP))
  if (mBody) { const v = check(mBody[1]); if (v) return v }
  if (attachText && attachText.trim()) {
    const mAtt = attachText.match(rSameLine(SEP_ATT))
    if (mAtt) { const v = check(mAtt[1]); if (v) return v }
  }
  const allText = bodyText + '\n' + (attachText ?? '')
  const rSingle = new RegExp(`(?:${esc}) ([^ \\t,，\\n　]{1,${maxLen}})`, 'i')
  const mSingle = allText.match(rSingle)
  if (mSingle) { const v = check(mSingle[1], phase3MinLen); if (v) return v }
  return null
}

// STATION_TO_PREFECTURE は本体と完全一致させたいので、サンプルとして主要駅を抜粋
const STATION_TO_PREFECTURE = {
  // 神奈川県（小田急江ノ島線含む）
  '横浜': '神奈川県', '川崎': '神奈川県', '武蔵小杉': '神奈川県',
  '藤沢': '神奈川県', '六会日大前': '神奈川県', '茅ヶ崎': '神奈川県',
  '平塚': '神奈川県', '小田原': '神奈川県',
  '鶴見': '神奈川県', '大船': '神奈川県',
  // 東京都
  '町田': '東京都',
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
  { re: /PM|プロジェクト[　 ]?マネージャー/, label: 'プロジェクトマネージャー' },
  { re: /PL|プロジェクト[　 ]?リーダー/, label: 'プロジェクトリーダー' },
  { re: /TL|テックリード|テック[　 ]?リード/, label: 'テックリード' },
  { re: /(?<![バックエンドフロントクラウドデータML])SE(?![A-Z])|システム[　 ]?エンジニア(?!長)/, label: 'システムエンジニア' },
  { re: /PG|プログラマー?/, label: 'プログラマー' },
  { re: /インフラ[　 ]?エンジニア/, label: 'インフラエンジニア' },
  { re: /フロントエンド[　 ]?エンジニア|フロント[　 ]?エンジニア/, label: 'フロントエンドエンジニア' },
  { re: /バックエンド[　 ]?エンジニア|バック[　 ]?エンジニア/, label: 'バックエンドエンジニア' },
  { re: /フルスタック[　 ]?エンジニア/, label: 'フルスタックエンジニア' },
  { re: /クラウド[　 ]?エンジニア/, label: 'クラウドエンジニア' },
  { re: /データ[　 ]?エンジニア/, label: 'データエンジニア' },
  { re: /MLエンジニア|機械学習[　 ]?エンジニア/, label: 'MLエンジニア' },
  { re: /スクラム[　 ]?マスター/, label: 'スクラムマスター' },
  { re: /アーキテクト/, label: 'アーキテクト' },
  { re: /コンサルタント/, label: 'コンサルタント' },
  { re: /要件定義/, label: '要件定義' },
  { re: /基本設計/, label: '基本設計' },
  { re: /詳細設計/, label: '詳細設計' },
  { re: /テスト[　 ]?(?:リード|エンジニア|設計)/, label: 'テストエンジニア' },
  { re: /運用[　 ]?(?:保守|管理)/, label: '運用保守' },
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

// ──────────────────────────────────────────────────────────────
// 入力（YN氏スキルシート）— 添付想定で attachText に流す
// ──────────────────────────────────────────────────────────────

const SUBJECT = 'YN様　経歴書送付の件'
const BODY = '' // メール本文は空想定（添付のみ）

const ATTACH_TEXT = `経歴書 技術経歴書

氏名 YN 男 生年月日 1993年10月26日 32歳
最終学歴 嘉悦大学経営経済学部 2016/03 卒業
最寄駅 小田急電鉄江ノ島線 六会日大前駅

OS Windows Mac Linux Android ios
言語 JAVA SQL JavaScript Ruby Java Servlet HTML CSS
DB Oracle SQLServer MySQL PostgreSQL SQLite Access DB2
他 Excel Slack Chatwork Zabbix redmain Git Git hub Visual SourceSafe Backlog Docker

1 ビルメンテナンス 2017/04 ～ 2019/05 一般事務・営業サポート
一般事務作業(Excelでの資料作成) 電話対応
役割 事務員
OS Windows / ツール Excel、Outlook

2 受託開発 2019/06 ～ 2019/07 ECサイトWEBテスト
ECサイトの総合テストでテストケースを作成しながらテストを実施。
バグが見つかったときに開発チームへ連携。
役割 テスター
OS Windows / ツール Excel、Outlook

3 大手旅行会社・役所関係 2019/07 ～ 2019/08 PCキッティング作業
Windows PC 数百台(100台/月)のキッティング・インストール作業
Windows7から8へのアップグレード、AD追加作業、各種試験、ドキュメント作成
役割 キッティング・テスター
OS Windows8 / ツール Excel

4 大手交通機関企業 2019/08 ～ 2020/03 タブレットとスマートフォンのテスト作業
1日150項目程の結合テスト実施及びテストケースの追加・修正(総合テスト)
役割 テスター
OS Windows10, iOS, Android / ツール Excel、Slack、Chatwork

5 大手電機会社 2020/04 ～ 2020/07 料金試算ツールのテスト
総合テストの実施(料金ツールのサイトをPCで実施)
SQLを使用してのテスト実施
役割 テスター
OS Windows / 言語 SQL / DB DB2 / ツール Excel、A5SQL、Tera Term、WinSCP、RTC

6 大手テレビ会社 2021/02 ～ 2021/03 視聴率集計管理システムのテスト
総合テストの実施
役割 テスター
OS Windows / 言語 マクロ / ツール Excel、Teams、SharePoint、Outlook、slack、Redmain、Backlog

7 デジタルコンテンツ制作会社 2021/04 ～ 2021/07 銀行アプリのテスト
総合テストの実施(iOSとAndroidの端末で実施)
結合テスト、単体テストの実施
役割 テスター
OS Windows、iOS、Android / ツール スプレッドシート、Slack、Google Meet、Github、Redmain

8 コンサルタント企業 2021/07 ～ 2021/12 大学の履修システムのテスト
総合テストの実施(PCの画面でテスト)
テスト設計(Excelで作成)
役割 テスター
OS Windows / ツール zoom、Redmain、Excel

9 大手携帯会社 2022/01 ～ 2023/03 スマートフォン購入システム
総合テストの実施(PCの画面でテスト)
テスト設計(Excelで作成)
役割 テスター
OS Windows / ツール ウェブカン、Google Meet、SoQoS、Excel、A5SQL、電文

10 大手ECサイト会社 2023/04 ～ 2023/08 出店店舗様向けアプリ、ECサイト
出店店舗様向けアプリは端末(iOSとAndroid)でテスト
ECサイトはPC(WindowsとMac)と端末(iOSとAndroid)でテスト
役割 テスター
OS Windows、iOS、Android / ツール Slack、Zoom、Skype、Excel、スプレッドシート、Charles

11 大手某大手Sier 2023/09 ～ 2023/12 通販ECサイト
総合テストの実施。外部結合テストの実施。
役割 テスター
OS Windows / 言語 SQL / DB Oracle、PostgreSQL / ツール teams、Excel、Box、HULFT、object browser、JP1

12 大手IT会社 2024/01 ～ 2024/06 電気需給調整システム
総合テストの実施(PCの画面でテスト)
総合テストのテスト設計
役割 テスター
OS Windows / ツール Teams、Excel、Redmain

13 大手携帯会社 2024/07 ～ 2025/03 まちアプリ
受入テストの実施(iPhone or Android(スマートフォン)で実施)
受入テストのテスト設計(試験項目書作成)
役割 テスター
OS Windows / ツール Teams、Excel、Jira

14 大手携帯会社 2025/04 ～ 2025/10 駐車場のクラウドシステム
パーキングの検証(PCの画面で実施)
AWS環境での検証
Linuxコマンドを使用して権限の変更や、ログの確認を行う作業
役割 テスター
OS Windows、Linux、AWS / ツール Teams、Excel、Notes、WinSCP、TeraTerm、Outlook

15 IT会社 2025/12 ～ 2026/04 車両リース会社向けモバイルアプリ、入居者様サポートアプリ(AIチャット画面)
結合テスト及び総合テストのテスト設計
結合テスト及び総合テストのテスト実施
実施端末:AndroidとiOS
役割 テスター
OS Mac、iOS、Android / ツール Slack、Zoom、Excel、ス