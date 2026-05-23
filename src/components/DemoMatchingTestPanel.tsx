import { useState } from 'react'
import { Loader2, FlaskConical, CheckCircle2, XCircle } from 'lucide-react'
import type { DataEnv } from '../lib/dataEnv'
import { upsertCandidate } from '../lib/db/candidates'
import { insertProject } from '../lib/db/projects'

interface Props {
  nickname: string
  dataEnv: DataEnv
  onDone: () => void
}

const PROJ_A_SKILLS = ['Java', 'Spring Boot', 'テスト', '保守開発', '基本設計']
const PROJ_B_SKILLS = ['Python', 'pandas', 'SQL', 'BigQuery']
const ALL_SKILLS = [...PROJ_A_SKILLS, ...PROJ_B_SKILLS]

interface TestRow {
  no: string
  label: string
  name: string
  skills: string[]
  experienceYears: number
  desiredRate: string
  prefecture: string
  remoteAvailable: boolean
  nationality: string | null
  expectedA: number
  expectedB: number
}

const TEST_ROWS: TestRow[] = [
  { no: '①', label: '全要素合致（基準）',    name: '山田 太一', skills: ALL_SKILLS,         experienceYears: 12, desiredRate: '75万', prefecture: '東京都', remoteAvailable: true,  nationality: null,     expectedA: 100, expectedB: 90 },
  { no: '②', label: 'スキル不足のみ',        name: '山田 二郎', skills: ['Java','Python'],  experienceYears: 12, desiredRate: '75万', prefecture: '東京都', remoteAvailable: true,  nationality: null,     expectedA: 68,  expectedB: 60 },
  { no: '③', label: '経験不足のみ',          name: '山田 三郎', skills: ALL_SKILLS,         experienceYears: 1,  desiredRate: '75万', prefecture: '東京都', remoteAvailable: true,  nationality: null,     expectedA: 87,  expectedB: 77 },
  { no: '④', label: '単価超過のみ',          name: '山田 四朗', skills: ALL_SKILLS,         experienceYears: 12, desiredRate: '100万', prefecture: '東京都', remoteAvailable: true,  nationality: null,     expectedA: 85,  expectedB: 83 },
  { no: '⑤', label: '地方×リモート不可',    name: '山田 五郎', skills: ALL_SKILLS,         experienceYears: 12, desiredRate: '75万', prefecture: '北海道', remoteAvailable: false, nationality: null,     expectedA: 70,  expectedB: 90 },
  { no: '⑥', label: '地方×リモート可',      name: '山田 六朗', skills: ALL_SKILLS,         experienceYears: 12, desiredRate: '75万', prefecture: '北海道', remoteAvailable: true,  nationality: null,     expectedA: 80,  expectedB: 90 },
  { no: '⑦', label: '外国籍（全合致）',     name: '山田 七子', skills: ALL_SKILLS,         experienceYears: 12, desiredRate: '75万', prefecture: '東京都', remoteAvailable: true,  nationality: '中国籍', expectedA: 100, expectedB: 90 },
  { no: '⑧', label: '複合低スコア',          name: '山田 八朗', skills: ['Java','Python'],  experienceYears: 1,  desiredRate: '100万', prefecture: '北海道', remoteAvailable: false, nationality: null,     expectedA: 10,  expectedB: 40 },
]

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-700 font-semibold'
  if (score >= 60) return 'text-blue-700 font-semibold'
  if (score >= 40) return 'text-yellow-700 font-semibold'
  return 'text-red-600 font-semibold'
}

export function DemoMatchingTestPanel({ nickname, dataEnv, onDone }: Props) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    setRunning(true)
    setDone(false)
    setError(null)
    try {
      // 案件A
      setProgress('案件作成中... (1/2)')
      await insertProject({
        analyzed: {
          title: 'Java保守開発案件（週3日リモート可）[TEST]',
          client: null,
          description: 'Java/Spring Bootを使った業務システムの保守開発案件。週3日リモート可。テストデータ。',
          requiredSkills: PROJ_A_SKILLS,
          niceToHaveSkills: ['Angular', 'SQL'],
          budgetMin: 50,
          budgetMax: 80,
          workLocation: '東京都大森',
          remotePolicy: '週3日リモート可',
          startDate: '2026-07-01',
        },
        rawText: 'Java保守開発案件 テストデータ',
        createdBy: `${nickname}(match-test)`,
        dataEnv,
      })

      // 案件B
      setProgress('案件作成中... (2/2)')
      await insertProject({
        analyzed: {
          title: 'Pythonデータ分析案件（フルリモート・日本国籍限定）[TEST]',
          client: null,
          description: 'BigQueryを活用したデータ分析業務。フルリモート勤務可能。日本国籍限定。テストデータ。',
          requiredSkills: PROJ_B_SKILLS,
          niceToHaveSkills: ['Tableau'],
          budgetMin: 60,
          budgetMax: 90,
          workLocation: '東京都',
          remotePolicy: 'フルリモート',
          startDate: '2026-07-01',
        },
        rawText: 'Pythonデータ分析案件 テストデータ',
        createdBy: `${nickname}(match-test)`,
        dataEnv,
      })

      // 人材8名
      for (let i = 0; i < TEST_ROWS.length; i++) {
        const row = TEST_ROWS[i]!
        setProgress(`人材作成中... (${i + 3}/${TEST_ROWS.length + 2})`)
        await upsertCandidate({
          analyzed: {
            name: row.name,
            email: `match-test-${row.no}@test.invalid`,
            phone: null,
            skills: row.skills,
            experienceYears: row.experienceYears,
            summary: `${row.label}テスト用人材。${row.skills.slice(0, 3).join('/')}の経験${row.experienceYears}年。希望単価${row.desiredRate}。`,
            prefecture: row.prefecture,
            remoteAvailable: row.remoteAvailable,
            desiredRate: row.desiredRate,
            nationality: row.nationality,
          },
          rawText: `テストデータ: ${row.label}`,
          createdBy: `${nickname}(match-test)`,
          dataEnv,
          duplicateSuspected: false,
        })
      }

      setDone(true)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      setProgress('')
    }
  }

  return (
    <div className="border border-indigo-200 bg-indigo-50 rounded-xl p-4 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <FlaskConical size={16} className="text-indigo-600" />
        <span className="text-sm font-semibold text-indigo-800">マッチングテストデータ生成</span>
      </div>

      <p className="text-xs text-indigo-700 mb-3">
        スコアリングの動作検証用に、2案件と8人材をデモ環境に一括生成します。<br />
        各人材はスキル・経験・単価・勤務地・国籍のいずれか1要素を変えたテストケースです。
      </p>

      {!done && (
        <button
          onClick={handleGenerate}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {running ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              {progress || '生成中...'}
            </>
          ) : (
            <>
              <FlaskConical size={14} />
              テストデータ一括生成（2案件 × 8人材）
            </>
          )}
        </button>
      )}

      {error && (
        <div className="mt-3 flex items-center gap-2 text-red-600 text-sm">
          <XCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {done && (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-green-700 text-sm mb-3">
            <CheckCircle2 size={14} />
            <span>生成完了（2案件 + 8人材）</span>
          </div>

          <div className="overflow-x-auto">
            <table className="text-xs w-full border border-indigo-200 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-indigo-100 text-indigo-800">
                  <th className="px-2 py-1.5 text-left">No</th>
                  <th className="px-2 py-1.5 text-left">テスト観点</th>
                  <th className="px-2 py-1.5 text-left">名前</th>
                  <th className="px-2 py-1.5 text-center">A期待点</th>
                  <th className="px-2 py-1.5 text-center">B期待点</th>
                </tr>
              </thead>
              <tbody>
                {TEST_ROWS.map((row) => (
                  <tr key={row.no} className="border-t border-indigo-100 bg-white even:bg-indigo-50/40">
                    <td className="px-2 py-1.5 text-indigo-700 font-mono">{row.no}</td>
                    <td className="px-2 py-1.5 text-gray-700">{row.label}</td>
                    <td className="px-2 py-1.5 text-gray-800">{row.name}</td>
                    <td className={`px-2 py-1.5 text-center ${scoreColor(row.expectedA)}`}>{row.expectedA}</td>
                    <td className={`px-2 py-1.5 text-center ${scoreColor(row.expectedB)}`}>{row.expectedB}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-indigo-600 mt-2">
            スコア凡例: <span className="text-green-700 font-semibold">80+</span> / <span className="text-blue-700 font-semibold">60-79</span> / <span className="text-yellow-700 font-semibold">40-59</span> / <span className="text-red-600 font-semibold">40未満</span>
          </p>
        </div>
      )}
    </div>
  )
}
