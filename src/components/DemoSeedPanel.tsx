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

function buildDemoPair(seed: number): { analyzedCandidate: AnalyzeCandidateResponse; analyzedProject: AnalyzeProjectResponse } {
  const stacks = [
    {
      role: 'バックエンド',
      langs: ['TypeScript', 'Node.js'],
      fw: ['NestJS', 'Express'],
      db: ['PostgreSQL', 'Redis'],
      cloud: ['AWS'],
      biz: 'API開発・決済連携',
    },
    {
      role: 'フロントエンド',
      langs: ['TypeScript', 'JavaScript'],
      fw: ['React', 'Next.js'],
      db: [],
      cloud: ['Vercel'],
      biz: 'Webアプリ画面開発',
    },
    {
      role: 'インフラ/SRE',
      langs: ['Shell'],
      fw: [],
      db: [],
      cloud: ['AWS', 'GCP'],
      biz: 'IaC・監視・運用自動化',
    },
    {
      role: 'データ基盤',
      langs: ['SQL', 'Python'],
      fw: [],
      db: ['BigQuery', 'PostgreSQL'],
      cloud: ['GCP'],
      biz: 'ETL・ダッシュボード',
    },
  ] as const

  const s = stacks[seed % stacks.length]
  const exp = randInt(3, 18)

  const requiredSkills = Array.from(
    new Set([...s.langs.slice(0, 2), ...(s.fw.slice(0, 1)), ...(s.db.slice(0, 1))].filter(Boolean)),
  )

  const niceToHaveSkills = Array.from(new Set([...(s.cloud.slice(0, 1)), 'Docker', 'Git'].filter(Boolean)))

  const budgetMin = randInt(45, 75)
  const budgetMax = Math.min(budgetMin + randInt(0, 15), 120)

  const candidateSkills = Array.from(
    new Set([
      ...requiredSkills,
      ...niceToHaveSkills,
      randPick(['Jira', 'Slack', 'Notion']),
      randPick(['要件定義', '設計', 'コードレビュー']),
    ]),
  ).slice(0, 12)

  const sbc = {
    languages: [...s.langs],
    frameworks: [...s.fw],
    libraries: [] as string[],
    os: ['Linux'],
    databases: [...s.db],
    dwh: [] as string[],
    clouds: [...s.cloud],
    infrastructures: ['Docker'],
    tools: ['Git', 'Slack'],
    methodologies: ['アジャイル'],
    certifications: [],
    design: [],
    marketing: [],
    others: [],
  }

  const analyzedCandidate: AnalyzeCandidateResponse = {
    name: `デモ_${s.role}_${seed}`,
    email: makeEmail('demo.candidate'),
    phone: null,
    skills: candidateSkills,
    experienceYears: exp,
    summary: `${s.role}として${exp}年程度。${s.biz}の経験。`,
    skillsByCategory: sbc,
    roles: [s.role],
    industries: ['IT'],
    nearestStation: '東京都 例駅',
    prefecture: '東京都',
    availableRegions: ['東京都'],
    currentWorkLocation: '東京都',
    remoteAvailable: randPick([true, false]),
  }

  const analyzedProject: AnalyzeProjectResponse = {
    title: `デモ案件_${s.role}_${seed}`,
    client: `デモクライアント_${randInt(1, 99)}`,
    description: `${s.biz}。チーム開発。ドキュメント作成あり。`,
    requiredSkills,
    niceToHaveSkills,
    budgetMin,
    budgetMax,
    startDate: null,
    endDate: null,
    workLocation: randPick(['東京都（ハイブリッド）', 'フルリモート', '大阪府（週2出社）']),
    remotePolicy: randPick(['フルリモート可', 'ハイブリッド', '出社']),
    contractType: randPick(['業務委託', '準委任']),
    headcount: randInt(1, 3),
    workload: '週5',
    settlementMin: 140,
    settlementMax: 180,
    roleSummary: s.role,
    industry: 'IT',
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
