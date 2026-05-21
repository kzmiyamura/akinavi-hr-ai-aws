import { useState } from 'react'
import { Loader2, Users } from 'lucide-react'
import type { Project } from '../lib/db/projects'
import type { DataEnv } from '../lib/dataEnv'
import type { AnalyzeCandidateResponse } from '../lib/ai/types'
import { upsertCandidate } from '../lib/db/candidates'

interface Props {
  project: Project
  nickname: string
  dataEnv: DataEnv
  onDone: () => void
}

// ─── 名前プール ───────────────────────────────────────────────────────────────
const LAST_NAMES = ['田中', '鈴木', '佐藤', '高橋', '渡辺', '伊藤', '山本', '中村', '小林', '加藤']
const FIRST_NAMES = ['健太', '翔太', '拓也', '雅人', '誠', '奈々', '明美', '裕子', '麻衣', '由美']

// ─── スキルプール（ドメイン別） ──────────────────────────────────────────────
const SKILL_POOLS: Record<string, string[]> = {
  web:    ['React', 'Vue.js', 'Angular', 'TypeScript', 'JavaScript', 'HTML/CSS', 'Next.js', 'Nuxt.js'],
  java:   ['Java', 'Spring Boot', 'Maven', 'JUnit', 'MyBatis', 'Struts', 'Hibernate'],
  db:     ['SQL', 'Oracle Database', 'PostgreSQL', 'MySQL', 'SQLite', 'PL/SQL'],
  infra:  ['AWS', 'Docker', 'Kubernetes', 'Terraform', 'Linux', 'Nginx', 'CI/CD', 'GitHub Actions'],
  mobile: ['iOS', 'Android', 'Swift', 'Kotlin', 'Flutter', 'React Native'],
  data:   ['Python', 'pandas', 'scikit-learn', 'BigQuery', 'Spark', 'Tableau', 'Power BI'],
  cobol:  ['COBOL', 'JCL', 'VSAM', 'IBM Mainframe', 'CICS'],
  net:    ['C#', '.NET', 'ASP.NET', 'Azure', 'WPF', 'Visual Studio'],
}

function pickRandom<T>(arr: T[], n: number, seed: number): T[] {
  const shuffled = [...arr].sort((a, b) => {
    const ha = String(a).split('').reduce((s, c) => s + c.charCodeAt(0), seed)
    const hb = String(b).split('').reduce((s, c) => s + c.charCodeAt(0), seed + 1)
    return (ha % 97) - (hb % 97)
  })
  return shuffled.slice(0, n)
}

function genName(seed: number): string {
  return `${LAST_NAMES[seed % LAST_NAMES.length]} ${FIRST_NAMES[(seed + 3) % FIRST_NAMES.length]}`
}

// 案件の必須スキルに近い別ドメインのスキルを返す
function getUnrelatedSkills(required: string[], n: number, seed: number): string[] {
  // 必須スキルに含まれないドメインから選ぶ
  const reqLower = required.map(s => s.toLowerCase())
  const usable: string[] = []
  for (const [, pool] of Object.entries(SKILL_POOLS)) {
    for (const s of pool) {
      if (!reqLower.some(r => r.includes(s.toLowerCase()) || s.toLowerCase().includes(r))) {
        usable.push(s)
      }
    }
  }
  return pickRandom(usable, n, seed)
}

interface ScoreLevel {
  label: string
  score: number
  skillRatio: number     // 必須スキルを何割持つか (0〜1)
  extraUnrelated: number // 無関係スキルを何個追加するか
  expYears: number
  rateOffset: number     // 予算上限からの差分（万円）正=超過
  prefecture: string
  sameLocation: boolean
  remoteAvailable: boolean
}

const SCORE_LEVELS: ScoreLevel[] = [
  { label: '超マッチ',     score: 90, skillRatio: 1.0, extraUnrelated: 1, expYears: 12, rateOffset: -5,  prefecture: '', sameLocation: true,  remoteAvailable: true  },
  { label: 'まあまあ合う', score: 70, skillRatio: 0.7, extraUnrelated: 2, expYears: 6,  rateOffset: 5,   prefecture: '', sameLocation: true,  remoteAvailable: true  },
  { label: '少し合う',     score: 50, skillRatio: 0.5, extraUnrelated: 3, expYears: 4,  rateOffset: 10,  prefecture: '', sameLocation: false, remoteAvailable: false },
  { label: 'あまり合わない', score: 30, skillRatio: 0.2, extraUnrelated: 5, expYears: 2,  rateOffset: 15,  prefecture: '', sameLocation: false, remoteAvailable: false },
  { label: '全く合わない', score: 10, skillRatio: 0.0, extraUnrelated: 6, expYears: 1,  rateOffset: 30,  prefecture: '', sameLocation: false, remoteAvailable: false },
]

const LOCATIONS = ['東京都', '神奈川県', '大阪府', '愛知県', '福岡県', '北海道', '宮城県', '広島県']

function buildCandidate(
  level: ScoreLevel,
  project: Project,
  idx: number,
): AnalyzeCandidateResponse & { desiredRate: string } {
  const required: string[] = Array.isArray(project.required_skills) ? project.required_skills.map(String) : []
  const seed = idx * 31 + (project.title?.charCodeAt(0) ?? 7)

  // スキル構成
  const matchCount = Math.max(0, Math.round(required.length * level.skillRatio))
  const matchedSkills = pickRandom(required, matchCount, seed)
  const extraSkills = getUnrelatedSkills(required, level.extraUnrelated, seed + 100)
  const skills = [...new Set([...matchedSkills, ...extraSkills])]

  // 単価
  const budgetMax = project.budget_max ?? 60
  const desiredRate = `${Math.max(20, budgetMax + level.rateOffset)}万`

  // 勤務地
  const projectPref = (project.work_location ?? '').replace(/[市区町村].*/g, '')
  const prefecture = level.sameLocation && projectPref
    ? projectPref
    : LOCATIONS[(seed + idx * 3) % LOCATIONS.length]

  // サマリー
  const topSkills = skills.slice(0, 3).join('/')
  const summary = `${topSkills}の経験${level.expYears}年。${level.expYears >= 8 ? '上流工程から対応可。' : ''}希望単価${desiredRate}。`

  return {
    name: genName(seed),
    email: null,
    phone: null,
    skills,
    experienceYears: level.expYears,
    summary,
    prefecture,
    availableRegions: level.sameLocation ? [prefecture] : [prefecture, LOCATIONS[(seed + 5) % LOCATIONS.length]],
    remoteAvailable: level.remoteAvailable,
    desiredRate,
  } as AnalyzeCandidateResponse & { desiredRate: string }
}

const SCORE_COLORS: Record<number, string> = {
  90: 'bg-green-100 text-green-800',
  70: 'bg-blue-100 text-blue-800',
  50: 'bg-yellow-100 text-yellow-800',
  30: 'bg-orange-100 text-orange-800',
  10: 'bg-red-100 text-red-800',
}

export function DemoProjectCandidateGen({ project, nickname, dataEnv, onDone }: Props) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [results, setResults] = useState<Array<{ label: string; name: string; score: number }>>([])

  async function handleGenerate() {
    setStatus('saving')
    setMessage(null)
    setResults([])

    try {
      const saved: typeof results = []
      for (let i = 0; i < SCORE_LEVELS.length; i++) {
        const level = SCORE_LEVELS[i]
        const built = buildCandidate(level, project, i)
        const { desiredRate, ...analyzed } = built

        const rawText = `${analyzed.name}\nスキル: ${analyzed.skills.join(', ')}\n経験: ${analyzed.experienceYears}年\n希望単価: ${desiredRate}\n${analyzed.summary}`
        // desiredRateはraw_profileに含める必要があるためrawTextに乗せる（upsertCandidate内でraw_profileを構築）
        // raw_profileのdesiredRateはsummaryから抽出される想定のため、rawTextに明記
        await upsertCandidate({
          analyzed: { ...analyzed, summary: `${analyzed.summary} [希望単価:${desiredRate}]` },
          rawText,
          createdBy: `${nickname}(demo-gen)`,
          dataEnv,
          duplicateSuspected: false,
        })
        saved.push({ label: level.label, name: analyzed.name, score: level.score })
      }

      setResults(saved)
      setStatus('done')
      onDone()
    } catch (e) {
      setStatus('error')
      setMessage(String(e))
    }
  }

  return (
    <div className="mt-4 border border-purple-200 rounded-lg bg-purple-50 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-semibold text-purple-700 flex items-center gap-1">
          <Users size={13} />
          デモ人材生成（この案件ベース）
        </span>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={status === 'saving'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {status === 'saving'
            ? <><Loader2 size={12} className="animate-spin" />保存中...</>
            : <>スコア別5人を生成</>}
        </button>
      </div>

      {status === 'done' && results.length > 0 && (
        <div className="space-y-1">
          {results.map((r) => (
            <div key={r.name} className="flex items-center gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded font-medium ${SCORE_COLORS[r.score] ?? 'bg-gray-100 text-gray-700'}`}>
                {r.score}点
              </span>
              <span className="text-gray-700">{r.label} — {r.name}</span>
            </div>
          ))}
          <p className="text-xs text-purple-600 mt-1">人材タブに追加されました</p>
        </div>
      )}

      {status === 'error' && (
        <p className="text-xs text-red-600 mt-1">{message}</p>
      )}
    </div>
  )
}
