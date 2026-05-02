import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { insertProject } from '../lib/db/projects'
import { upsertCandidate } from '../lib/db/candidates'
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
function buildDemoPair(seed: number): { analyzedCandidate: AnalyzeCandidateResponse; analyzedProject: AnalyzeProjectResponse } {
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
    industries: s.industriesC,
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

  const analyzedProject: AnalyzeProjectResponse = {
    title: projectTitle,
    client,
    description: [
      `【背景】${s.projectHook}。既存チームと協業し、設計書・テスト観点の整備も依頼予定です。`,
      `【稼働】週5を想定。状況によりオンコールの可能性あり（要相談）。`,
      `【環境】GitHub、Slack、${randPick(['Notion', 'Confluence'])}でドキュメント管理。`,
    ].join(''),
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

  return { analyzedCandidate, analyzedProject }
}

interface Props {
  nickname: string
  createdByLabel: string
  onDone: () => void
}

export function DemoSeedPanel({ nickname, createdByLabel, onDone }: Props) {
  const [count, setCount] = useState(5)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const label = useMemo(() => `${createdByLabel}（demo）`, [createdByLabel])

  async function run() {
    setBusy(true)
    setMsg(null)
    try {
      for (let i = 0; i < count; i++) {
        const { analyzedCandidate, analyzedProject } = buildDemoPair(i + randInt(1, 1000))
        await upsertCandidate({
          analyzed: analyzedCandidate,
          rawText: analyzedCandidate.summary,
          createdBy: nickname,
          duplicateSuspected: false,
          dataEnv: 'demo',
        })
        await insertProject({
          analyzed: analyzedProject,
          rawText: analyzedProject.description,
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

      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-lg bg-amber-700 text-white px-4 py-2 text-sm font-medium hover:bg-amber-800 disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : null}
        {busy ? '追加中...' : `${label} で追加`}
      </button>
    </div>
  )
}
