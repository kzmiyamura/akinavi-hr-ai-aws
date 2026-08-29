/**
 * poll-email の「件名だけで人材メールと判定する」ルールの回帰テスト。
 *
 * 2026-08-28、人材メールが案件と判定され、案件解析OFFのため何も保存されずに
 * 捨てられていた（実測3日で733件）。原因は「要件定義」「案件希望」等、人材メールが
 * 普通に含む語を案件の証拠として扱っていたこと。
 *
 * 正は supabase/functions/poll-email/index.ts の isCandidateBySubject。
 * ここはその写しなので、index.ts を変更したら必ずこちらも合わせる。
 * 件名は実データ由来だが、イニシャル・会社名・駅名は伏せてある。
 */
import { describe, it, expect } from 'vitest'

const CANDIDATE_SUBJECT_HEADER =
  /【[^】]{0,10}人材|★[^★】]{0,10}人材|人材情報|人材[ー－-]|要員情報|要員紹介|技術者情報|(?:弊社)?(?:正社員)?技術者の?ご紹介|弊社技術者|自社\s*要員|スキルシート|経歴書/
const CANDIDATE_SUBJECT_AGE =
  /\d{2}\s*歳(?!\s*(?:位|くらい|程度|前後)?\s*(?:まで|迄|以下|未満|以上|前後))/
const CANDIDATE_SUBJECT_PHRASE =
  /案件(?:希望|のみ希望|を?探し|ご紹介くださ|をご紹介くださ)|参画先(?:希望|募集)/
const HARD_PROJECT_SUBJECT =
  /【\s*案件|案件情報|案件のご紹介|案件ご紹介\s*[】)）]|必須スキル|【商\s*流】|募集|人月|エンド直|直案件|元請け?直|エンジニア様?のご紹介をお待ち|見合う方がおりましたら/

function isCandidateBySubject(subject: string): boolean {
  if (HARD_PROJECT_SUBJECT.test(subject)) return false
  return CANDIDATE_SUBJECT_HEADER.test(subject)
    || CANDIDATE_SUBJECT_AGE.test(subject)
    || CANDIDATE_SUBJECT_PHRASE.test(subject)
}

describe('isCandidateBySubject: 人材メールを取りこぼさない', () => {
  // 2026-08-28 まで実際に案件扱いで捨てられていた件名
  const 人材 = [
    '【人材情報】Salesforceエンジニア｜Apex・SalesCloud・Java15年',
    '【人材情報】38歳男性／Java（Spring）／要件定義～／PMO・リーダー経験有／9月～',
    '★人材情報★JAVA開発案件希望です！お人柄抜群でございます！◎',
    '【弊社正社員技術者のご紹介】55歳男性/RPG、ILE/RPG/企画・提案、要件定義、基本設計',
    '★PMP保有！PMO×Java開発経験！【人材－PMO,PMP,プロジェクト管理,要件定義】',
    '【NW要件定義～技術者】31歳男性／Cisco,Nexus／Linux,WindowsServer,AWS／PMO経験有',
    '★★【おすすめ人材！！】C#★★',
    '【プラウド要員情報】●9月～／事務・業務支援5年4ヶ月／ヘルプデスク1年6ヶ月',
    '【10月/Java経験5年エンジニア/常駐可】Java案件探してます!/Javascript,SQL,HTML,CSS/70万円',
    '【GFD人材】インフラ/10月/AWS/EC2/Lambda/VPC/AWS案件ご紹介ください！',
    '【直人材のご紹介】C言語、C++、RTOS/69-74万',
    'プロパ技術者のご提案（C#・Java、9月～、常駐可、24歳・3年目）',
    '条件変更【人材情報】フルスタックエンジニア｜React/Next.js×TypeScript◎｜要件定義～運用まで対応',
  ]
  for (const s of 人材) {
    it(`人材と判定する: ${s.slice(0, 32)}`, () => {
      expect(isCandidateBySubject(s)).toBe(true)
    })
  }
})

describe('isCandidateBySubject: 案件メールを人材に化けさせない', () => {
  // 案件メール。特に年齢制限（NN歳まで/以上/前後）を人材の年齢と誤読しないこと
  const 案件 = [
    '【案件】10月/Redmine/構築/サーバ移行・更改',
    '【元請直案件】セキュリティ施策導入・PMO支援',
    '【TKC案件】【※面談1回 弊社独占 増員 ASP.Net C# 詳細設計～ 45歳まで】【9月～】',
    '【10月開始/60歳位まで】RPGの開発経験を上流からフルに活かせる社内SE案件',
    '【10月/事務案件/23歳以上】事務での受発注の経験等ある方募集してます。',
    '60歳前後の方も検討可！★【元請け直 / 金融, 銀行, 要件定義～ / 80～90万】銀行向け預金領域',
    '【Windows or Linuxでの詳細設計～構築経験3年以上ある方募集！】9月 ～',
    '【弊社注力案件！9月～】生成AIセキュリティ診断＆脆弱性分析',
    '【IDH案件情報】生命保険会社向け新契約システム保守案件／70万／11月～長期',
    '案件のご紹介【基本リモート/Python、PostgreSQL、Snowflake/10月～】',
    '【案件配信】9月～/元請直！iPad、スマホのキッティング、1名募集！',
  ]
  for (const s of 案件) {
    it(`案件のままにする: ${s.slice(0, 32)}`, () => {
      expect(isCandidateBySubject(s)).toBe(false)
    })
  }
})

describe('年齢の読み分け', () => {
  it('「38歳男性」は人材の年齢', () => {
    expect(CANDIDATE_SUBJECT_AGE.test('38歳男性')).toBe(true)
  })
  for (const limit of ['45歳まで', '60歳位まで', '23歳以上', '60歳前後', '50歳以下']) {
    it(`「${limit}」は案件の年齢条件なので人材の証拠にしない`, () => {
      expect(CANDIDATE_SUBJECT_AGE.test(limit)).toBe(false)
    })
  }
})
