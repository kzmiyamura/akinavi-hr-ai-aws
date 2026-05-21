import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { insertProject } from '../lib/db/projects'
import { upsertCandidate, copyProdCandidatesToDemo } from '../lib/db/candidates'
import { supabase } from '../lib/supabase'
import type { AnalyzeProjectResponse } from '../lib/ai/types'
import type { AnalyzeCandidateResponse } from '../lib/ai/types'

function randPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function makeEmail(prefix: string): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}+${id}@demo.invalid`
}

/** 実際の求人・経歴書っぽいデモ用ペア（架空の個人・社名） */
/**
 * AnalyzeCandidateResponse からエージェントが送るようなメール本文を生成する。
 * inbound-email の regex/skill_master 抽出が動作するフォーマット。
 */
function buildCandidateEmailBody(
  c: AnalyzeCandidateResponse,
  exp: number,
  agentComment: string,
  agentName: string,
  agentCompany: string,
): string {
  const sbc = c.skillsByCategory
  const skillLines = sbc
    ? [
        sbc.languages?.length      ? `言語: ${sbc.languages.join('、')}` : '',
        sbc.frameworks?.length     ? `FW / ライブラリ: ${sbc.frameworks.join('、')}` : '',
        sbc.databases?.length      ? `DB: ${sbc.databases.join('、')}` : '',
        sbc.clouds?.length         ? `クラウド: ${sbc.clouds.join('、')}` : '',
        sbc.infrastructures?.length ? `インフラ: ${sbc.infrastructures.join('、')}` : '',
        sbc.tools?.length          ? `ツール: ${sbc.tools.join('、')}` : '',
        sbc.methodologies?.length  ? `開発手法: ${sbc.methodologies.join('、')}` : '',
        sbc.certifications?.length ? `資格: ${sbc.certifications.join('、')}` : '',
        sbc.os?.length             ? `OS: ${sbc.os.join('、')}` : '',
      ].filter(Boolean)
    : [`スキル: ${c.skills.join('、')}`]

  const genders = ['男性', '女性']
  const age = 25 + (exp * 1.5 | 0) + (exp % 3)
  const gender = genders[exp % 2]!
  const prevCompanyTypes = ['SIer', 'Webベンチャー', 'メガベンチャー', '事業会社（製造業）', 'ITコンサル', 'ソフトウェアベンチャー']
  const prevCompany = prevCompanyTypes[exp % prevCompanyTypes.length]!
  const startYear = new Date().getFullYear() - exp
  const midYear = startYear + Math.floor(exp * 0.4)
  const role = (c.roles ?? [])[0] ?? 'エンジニア'
  const industries = c.industries ?? []

  // 職歴ブロック（2〜3社分）
  const careerBlock = [
    `${startYear}年〜${midYear}年  ${prevCompany}（正社員）`,
    `  ${role}として主に${industries[0] ?? 'IT'}業界の案件に従事。`,
    `  ${c.summary.split('。')[1] ?? '設計・開発・テストまで一貫して対応。'}`,
    ``,
    `${midYear}年〜現在  フリーランス`,
    `  独立後も${role}として複数社にて稼働継続。`,
    `  ${c.summary.split('。')[0] ?? '直近は大手クライアント向けシステム開発を担当。'}`,
  ].join('\n')

  return `お世話になっております。${agentCompany}の${agentName}でございます。
弊社にご登録いただいておりますエンジニアをご紹介させていただきます。
ご検討のほどよろしくお願いいたします。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 候補者基本情報
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

氏名　　　: ${c.name}（${age}歳・${gender}）
最寄駅　　: ${c.nearestStation ?? '未記入'}
稼働エリア: ${(c.availableRegions ?? []).join('・') || '要相談'}
リモート　: ${c.remoteAvailable ? 'リモート可（週3〜フルリモート対応）' : '基本常駐（リモート相談可）'}
希望単価　: ${65 + exp}万〜${70 + exp}万円/月（精算幅 ${140 + exp * 2}〜${180 + exp * 2}h）
稼働開始　: 即日〜1ヶ月以内（調整可）
経験年数　: 約${exp}年
契約形態　: 業務委託（準委任）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 職務経歴概要
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${careerBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ スキルセット
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${skillLines.join('\n')}

【対応業種】
${industries.join('、') || '業種問わず対応可'}

【対応役割・ポジション】
${(c.roles ?? []).join('、') || role}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
■ 弊社コメント・人物像
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${agentComment}

ご不明な点やご要望がございましたら、お気軽にご連絡ください。
面談のご調整もすぐに対応可能です。どうぞよろしくお願いいたします。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${agentCompany}
担当: ${agentName}
TEL: 03-XXXX-XXXX | FAX: 03-XXXX-YYYY
Email: ${agentName.toLowerCase().replace(/\s/g, '.')}@${agentCompany.replace(/株式会社|合同会社|\s/g, '').toLowerCase()}.co.jp
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`.trim()
}

function buildDemoPair(seed: number): { analyzedCandidate: AnalyzeCandidateResponse; analyzedProject: AnalyzeProjectResponse; candidateEmailBody: string; projectDescription: string } {
  const stacks = [
    {
      role: 'バックエンドエンジニア',
      langs: ['TypeScript', 'Node.js', 'SQL'],
      fw: ['NestJS', 'Express'],
      db: ['PostgreSQL', 'Redis'],
      cloud: ['AWS'],
      dwh: [] as string[],
      biz: '決済・会員基盤のAPI設計〜実装、外部サービス連携',
      projectHook: '既存ECのカート・決済周りのリプレイスと負荷対策',
      industriesC: ['EC', 'SaaS', '金融FinTech'],
      industryP: 'EC・小売向けIT',
    },
    {
      role: 'フロントエンドエンジニア',
      langs: ['TypeScript', 'JavaScript', 'HTML/CSS'],
      fw: ['React', 'Next.js'],
      db: ['PostgreSQL'],
      cloud: ['Vercel', 'AWS'],
      dwh: [] as string[],
      biz: '管理画面・顧客向けWebのSPA開発、アクセシビリティ対応',
      projectHook: 'BtoB向けダッシュボードの新規開発とレガシー画面の段階的移行',
      industriesC: ['IT', 'マーケティング', 'メディア'],
      industryP: 'Web広告・マーケティング',
    },
    {
      role: 'インフラ／SRE',
      langs: ['Shell', 'YAML'],
      fw: [],
      db: [],
      cloud: ['AWS', 'GCP'],
      dwh: [] as string[],
      biz: 'Kubernetes運用、TerraformによるIaC、監視・アラート設計',
      projectHook: 'マルチアカウント環境の権限整理とCI/CDパイプライン整備',
      industriesC: ['クラウド', '製造', '通信'],
      industryP: '製造業向けIoT',
    },
    {
      role: 'データエンジニア',
      langs: ['SQL', 'Python'],
      fw: ['dbt'],
      db: ['BigQuery', 'PostgreSQL'],
      cloud: ['GCP'],
      dwh: ['BigQuery', 'Snowflake'],
      biz: 'ログ収集〜ワンバッチパイプライン、経営向けダッシュボード用データマート',
      projectHook: '売上・在庫データの日次集計とLooker Studioレポート整備',
      industriesC: ['小売', '物流', 'データ分析'],
      industryP: '物流・サプライチェーン',
    },
  ] as const

  const family = ['田中', '佐藤', '鈴木', '高橋', '渡辺', '伊藤', '山本', '中村', '小林', '加藤'][seed % 10]!
  const given = ['誠', '翔太', '大輔', '健一', '拓也', '美咲', '優子', 'あゆみ', '玲奈', '健'][seed % 10]!
  const displayName = `${family} ${given}`

  const clients = [
    '株式会社テックブリッジ',
    'グローバルスタンダード・ソリューションズ',
    'メディカルデータ・ラボ',
    'ネクストリンク情報システム',
    'ユナイテッドデジタルワークス',
    'サンライズエンジニアリング',
  ]
  const client = clients[seed % clients.length]!

  const s = stacks[seed % stacks.length]
  const exp = randInt(4, 22)

  const requiredSkills = Array.from(
    new Set([...s.langs.slice(0, 2), ...(s.fw.slice(0, 1)), ...(s.db.slice(0, 1))].filter(Boolean)),
  )

  const niceToHaveSkills = Array.from(
    new Set([...(s.cloud.slice(0, 1)), ...(s.dwh.slice(0, 1)), 'Docker', 'GitHub Actions'].filter(Boolean)),
  )

  const budgetMin = randInt(55, 85)
  const budgetMax = Math.min(budgetMin + randInt(5, 25), 130)

  const candidateSkills = Array.from(
    new Set([
      ...requiredSkills,
      ...niceToHaveSkills,
      randPick(['Jira', 'Slack', 'Notion', 'Confluence']),
      randPick(['要件定義', '基本設計', 'コードレビュー', 'オンコール対応']),
    ]),
  ).slice(0, 14)

  const region = seed % 3
  const loc =
    region === 0
      ? { prefecture: '東京都', station: '東京都港区 田町駅', regions: ['東京都', '神奈川県'] as string[], wl: '東京都' }
      : region === 1
        ? { prefecture: '大阪府', station: '大阪府大阪市 梅田駅', regions: ['大阪府', '京都府'] as string[], wl: '大阪府' }
        : { prefecture: '福岡県', station: '福岡県福岡市 博多駅', regions: ['福岡県'] as string[], wl: '福岡県' }

  const sbc = {
    languages: [...s.langs],
    frameworks: [...s.fw],
    libraries: s.role.includes('フロント') ? ['TanStack Query'] : [],
    os: ['Linux', 'macOS'],
    databases: [...s.db],
    dwh: [...s.dwh],
    clouds: [...s.cloud],
    infrastructures: ['Docker', 'GitHub Actions'],
    tools: ['Git', 'Slack', 'Jira'],
    methodologies: ['スクラム', 'コードレビュー'],
    certifications: seed % 4 === 0 ? ['AWS Certified Solutions Architect – Associate'] : [],
    design: [],
    marketing: [],
    others: [],
  }

  const summary = [
    `${displayName}。${s.role}として約${exp}年。${s.biz}を担当。`,
    `直近は${s.projectHook}に従事。設計レビュー・障害時の一次切り分けも経験。`,
    loc.prefecture === '東京都'
      ? 'リモート・ハイブリッド双方の実務あり。'
      : 'リモート中心だが出社・客先訪問の経験あり。',
  ].join('')

  const analyzedCandidate: AnalyzeCandidateResponse = {
    name: displayName,
    email: makeEmail('demo.candidate'),
    phone: randPick([null, `090-${randInt(1000, 9999)}-${randInt(1000, 9999)}`]),
    skills: candidateSkills,
    experienceYears: exp,
    summary,
    skillsByCategory: sbc,
    roles: [s.role, randPick(['テックリード', 'メンバー', 'サブリーダー'])],
    industries: [...s.industriesC],
    nearestStation: loc.station,
    prefecture: loc.prefecture,
    availableRegions: loc.regions,
    currentWorkLocation: loc.wl,
    remoteAvailable: randPick([true, false]),
  }

  const projectTitle =
    seed % 2 === 0
      ? `【${loc.prefecture.slice(0, 2)}】${s.projectHook.slice(0, 28)}…（${s.role}）`
      : `${client.replace(/株式会社|・/g, '').slice(0, 12)}向け ${s.role}募集`

  const docTool = randPick(['Notion', 'Confluence', 'Backlog'])
  const projectDescription = [
    `＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝`,
    `${projectTitle}`,
    `＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝`,
    ``,
    `【案件背景・概要】`,
    `${s.projectHook}。`,
    `既存チームと協業しながら、設計書・テスト観点の整備も担当いただく予定です。`,
    `業界: ${s.industryP}`,
    ``,
    `【必須スキル】`,
    ...requiredSkills.map(sk => `・${sk}`),
    ``,
    `【歓迎スキル】`,
    ...niceToHaveSkills.map(sk => `・${sk}`),
    ``,
    `【稼働・体制】`,
    `・稼働: 週5日（40h/週）想定。状況によりオンコールの可能性あり（要相談）`,
    `・チーム規模: ${randInt(3, 12)}名`,
    `・参画予定: 2026年6月〜（長期継続希望）`,
    ``,
    `【勤務条件】`,
    `・勤務地: ${loc.prefecture}（${randPick(['ハイブリッド', '一部リモート可', 'フルリモート可'])}）`,
    `・契約: 業務委託（準委任）`,
    `・単価: ${budgetMin ?? 60}万〜${budgetMax ?? 80}万円/月`,
    `・精算幅: ${randPick([140, 150, 160])}〜${randPick([175, 180, 190])}h`,
    ``,
    `【開発環境】`,
    `GitHub、Slack、${docTool}でドキュメント管理。`,
    ``,
    `ご質問・ご紹介は本メールにご返信ください。`,
    `よろしくお願いいたします。`,
  ].join('\n')

  const analyzedProject: AnalyzeProjectResponse = {
    title: projectTitle,
    client,
    description: projectDescription,
    requiredSkills,
    niceToHaveSkills,
    budgetMin,
    budgetMax,
    startDate: null,
    endDate: null,
    workLocation: randPick([
      `${loc.prefecture}（ハイブリッド）`,
      'フルリモート（日本国内）',
      `${loc.prefecture}オフィス＋リモート併用`,
    ]),
    remotePolicy: randPick(['週3リモート可', 'フルリモート可', 'ハイブリッド（週2出社目安）']),
    contractType: randPick(['業務委託（準委任）', '業務委託', '派遣']),
    headcount: randInt(1, 2),
    workload: randPick(['週5日（40h）', '週4〜5', '月20日']),
    settlementMin: randPick([140, 150, 160]),
    settlementMax: randPick([175, 180, 190]),
    roleSummary: s.role,
    industry: s.industryP,
  }

  const agentComments = [
    `コミュニケーション能力が高く、クライアントからの評判も良い方です。技術的な質問への回答も的確で、面談でも好印象を与えています。スキルセットは${s.role}として申し分なく、即戦力として活躍が期待できます。`,
    `前職での実績が豊富で、設計から実装・テストまで一貫して対応できる方です。チームでの協調性も高く、リーダー経験もあることから、中核メンバーとしてご活用いただけると思います。`,
    `責任感が強く、期限を守る姿勢が見受けられます。未経験の技術でも積極的にキャッチアップする意欲があり、成長意欲の高いエンジニアです。ご面談の際にぜひ直接確認いただければ幸いです。`,
    `技術力・人柄ともに弊社でも上位クラスの方です。複数案件からオファーをいただいているため、ご検討の場合はお早めにご連絡ください。`,
  ]
  const agentNames = ['山田 太郎', '佐々木 花子', '田村 拓海', '中島 由美']
  const agentCompanies = ['株式会社テックパートナーズ', '合同会社エンジニアコネクト', '株式会社スキルブリッジ', 'ネクストキャリア株式会社']
  const agentComment = agentComments[seed % agentComments.length]!
  const agentName = agentNames[seed % agentNames.length]!
  const agentCompany = agentCompanies[seed % agentCompanies.length]!

  const candidateEmailBody = buildCandidateEmailBody(analyzedCandidate, exp, agentComment, agentName, agentCompany)

  return { analyzedCandidate, analyzedProject, candidateEmailBody, projectDescription }
}

interface Props {
  nickname: string
  createdByLabel: string
  onDone: () => void
}

/** 同一人材疑いテスト用データを生成する（同名・同スタック・メール違い） */
function buildDuplicatePair(baseSeed: number): { base: AnalyzeCandidateResponse; dup: AnalyzeCandidateResponse } {
  const { analyzedCandidate: base } = buildDemoPair(baseSeed)
  // 同じ名前・ほぼ同じスキル、メールだけ別アカウント
  const dup: AnalyzeCandidateResponse = {
    ...base,
    email: makeEmail('demo.dup'),
    phone: base.phone ? base.phone.replace(/\d{4}$/, String(randInt(1000, 9999))) : null,
    summary: `【重複テスト】${base.summary}`,
    experienceYears: (base.experienceYears ?? 5) + randInt(-1, 1),
  }
  return { base, dup }
}

export function DemoSeedPanel({ nickname, createdByLabel, onDone }: Props) {
  const [count, setCount] = useState(5)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [copyBusy, setCopyBusy] = useState(false)
  const [copyRecentBusy, setCopyRecentBusy] = useState(false)
  const [replayBusy, setReplayBusy] = useState(false)

  const label = useMemo(() => `${createdByLabel}（demo）`, [createdByLabel])

  async function run() {
    setBusy(true)
    setMsg(null)
    try {
      for (let i = 0; i < count; i++) {
        const { analyzedCandidate, analyzedProject, candidateEmailBody, projectDescription } = buildDemoPair(i + randInt(1, 1000))
        await upsertCandidate({
          analyzed: analyzedCandidate,
          rawText: candidateEmailBody,
          createdBy: nickname,
          duplicateSuspected: false,
          dataEnv: 'demo',
        })
        await insertProject({
          analyzed: analyzedProject,
          rawText: projectDescription,
          createdBy: nickname,
          dataEnv: 'demo',
        })
      }
      setMsg(`デモデータを ${count} 件ずつ（人材/案件）追加しました`)
      onDone()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runDuplicateTest() {
    setBusy(true)
    setMsg(null)
    try {
      const seed = randInt(1, 1000)
      const { base, dup } = buildDuplicatePair(seed)
      await upsertCandidate({
        analyzed: base,
        rawText: base.summary,
        createdBy: nickname,
        duplicateSuspected: false,
        dataEnv: 'demo',
      })
      await upsertCandidate({
        analyzed: dup,
        rawText: dup.summary,
        createdBy: nickname,
        duplicateSuspected: true,
        dataEnv: 'demo',
      })
      setMsg(`同一人材疑いテスト用データを追加しました\n氏名: ${base.name}\n（同名・別メールの人材ペアを登録）`)
      onDone()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runReplayEmails() {
    setReplayBusy(true)
    setMsg(null)
    try {
      // デモ環境の人材を取得（ランダムに count 件選ぶ）
      const { data: pool, error: fetchErr } = await supabase
        .from('candidates')
        .select('id, name, raw_profile')
        .eq('data_env', 'demo')
        .eq('duplicate_flag', false)
        .limit(100)

      if (fetchErr) throw new Error(fetchErr.message)
      if (!pool?.length) throw new Error('デモ環境に人材データがありません')

      // raw_profile.text があるものだけ対象
      const withText = pool.filter(
        (c) => typeof (c.raw_profile as Record<string, unknown>)?.text === 'string'
          && ((c.raw_profile as Record<string, unknown>).text as string).length > 0
      )
      if (!withText.length) throw new Error('メール本文（raw_profile.text）を持つ人材がいません')

      // シャッフルして count 件選ぶ
      const selected = [...withText].sort(() => Math.random() - 0.5).slice(0, count)

      let done = 0
      let failed = 0
      for (const c of selected) {
        const rawText = (c.raw_profile as Record<string, unknown>).text as string
        // from はユニーク値にしてデdup・送信者上限チェックを回避
        const uniqueFrom = `replay+${c.id}@demo.invalid`
        const { error } = await supabase.functions.invoke('inbound-email', {
          body: {
            subject: `【再解析】${c.name}`,
            body: rawText,
            from: uniqueFrom,
            attachments: [],
            mode: 'demo',
            type: 'candidate',
          },
        })
        if (error) { failed++; console.error('[replay]', c.name, error) }
        else done++
      }

      setMsg(
        `${done}件を再解析しました（デモ環境に新規登録）` +
        (failed > 0 ? `\n失敗: ${failed}件` : '')
      )
      onDone()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setReplayBusy(false)
    }
  }

  async function runCopyProd() {
    setCopyBusy(true)
    setMsg(null)
    try {
      const copied = await copyProdCandidatesToDemo(count, nickname)
      setMsg(`本番人材データを ${copied} 件デモ環境にコピーしました`)
      onDone()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setCopyBusy(false)
    }
  }

  async function runCopyRecentProd() {
    setCopyRecentBusy(true)
    setMsg(null)
    try {
      const copied = await copyProdCandidatesToDemo(count, nickname, 'recent')
      setMsg(`本番人材データ（直近${copied}件）をデモ環境にコピーしました`)
      onDone()
    } catch (e) {
      setMsg(String(e))
    } finally {
      setCopyRecentBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-950">デモデータ投入（random）</p>
          <p className="text-xs text-amber-900/80 mt-1 break-words">
            `data_env=demo` のみに追加します（本番相当データとは分離）。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-amber-950 whitespace-nowrap">件数（各）</label>
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="border border-amber-300 rounded-lg px-2 py-1 text-sm bg-white"
          >
            {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      {msg && <p className="text-xs text-amber-950 whitespace-pre-wrap">{msg}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-amber-700 text-white px-4 py-2 text-sm font-medium hover:bg-amber-800 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {busy ? '追加中...' : `${label} で追加`}
        </button>
        <button
          type="button"
          onClick={runDuplicateTest}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-600 text-white px-4 py-2 text-sm font-medium hover:bg-orange-700 disabled:opacity-50"
          title="同名・別メールの人材ペアを登録して重複フラグ動作を確認"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {busy ? '追加中...' : '重複テスト用を追加'}
        </button>
        <button
          type="button"
          onClick={runCopyProd}
          disabled={busy || copyBusy || copyRecentBusy || replayBusy}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-700 text-white px-4 py-2 text-sm font-medium hover:bg-sky-800 disabled:opacity-50"
          title="本番の人材データをランダムにデモ環境へコピー"
        >
          {copyBusy ? <Loader2 size={16} className="animate-spin" /> : null}
          {copyBusy ? 'コピー中...' : '本番人材をランダムコピー'}
        </button>
        <button
          type="button"
          onClick={runCopyRecentProd}
          disabled={busy || copyBusy || copyRecentBusy || replayBusy}
          className="inline-flex items-center gap-2 rounded-lg bg-indigo-700 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-800 disabled:opacity-50"
          title="本番の人材データを直近登録順にデモ環境へコピー"
        >
          {copyRecentBusy ? <Loader2 size={16} className="animate-spin" /> : null}
          {copyRecentBusy ? 'コピー中...' : '本番人材を直近コピー'}
        </button>
        <button
          type="button"
          onClick={runReplayEmails}
          disabled={busy || copyBusy || copyRecentBusy || replayBusy}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-700 text-white px-4 py-2 text-sm font-medium hover:bg-violet-800 disabled:opacity-50"
          title="デモ環境の人材の保存済みメール本文を inbound-email へ再投入して再解析"
        >
          {replayBusy ? <Loader2 size={16} className="animate-spin" /> : null}
          {replayBusy ? '再解析中...' : 'メール本文を再解析'}
        </button>
      </div>
    </div>
  )
}
