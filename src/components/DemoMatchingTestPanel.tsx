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

// 案件A: Javaバックエンドリーダー（東京・週3リモート可・必須5スキル・60〜80万）
const PROJ_A_SKILLS = ['Java', 'Spring Boot', 'Docker', 'AWS', 'PostgreSQL']
// 案件B: フルスタック（フルリモート・日本国籍限定・必須4スキル・55〜75万）
const PROJ_B_SKILLS = ['Java', 'Spring Boot', 'React', 'TypeScript']

interface TestRow {
  no: string
  label: string
  name: string
  skills: string[]
  skillLabelA: string
  skillLabelB: string
  experienceYears: number
  desiredRate: string
  prefecture: string
  remoteAvailable: boolean
  roles: string[] | null
  selfPR: string | null
  nationality: string | null
  expectedA: number
  expectedB: number
  checkCommentA: string
  checkCommentB: string
}

// ルール計算根拠:
// 案件A: スキル(40) 経験(15) 単価(15) 勤務地(20) リモート(10) = 100pt max
// 案件B: フルリモートのため勤務地=20固定・リモート=0固定
// 案件Aスキル合致: 5/5→40 / 2/5→16
// 案件Bスキル合致: 4/4→40 / 2/4→20 (①〜⑧はJava・SBのみ持つ人はB=20)
const TEST_ROWS: TestRow[] = [
  {
    no: '①', label: '全要素合致（基準）', name: '山田 太一',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '70万', prefecture: '東京都', remoteAvailable: true,
    roles: ['バックエンド', 'リーダー'],
    selfPR: 'チームリーダーとして5名を率いた経験。設計から実装まで担当可能。',
    nationality: null,
    expectedA: 100, expectedB: 70,
    checkCommentA: 'スキル全合致・経験充足・単価OK。案件のリーダー人物像と本人希望(バックエンド・リーダー)が合致と記載されるか',
    checkCommentB: 'React・TS不足(2/4)。本人がバックエンド特化希望でフルスタック案件とのズレに言及するか',
  },
  {
    no: '②', label: 'スキル不足のみ', name: '山田 二郎',
    skills: ['Java', 'Spring Boot'], skillLabelA: '2/5 (Java・SB)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '70万', prefecture: '東京都', remoteAvailable: true,
    roles: null, selfPR: null, nationality: null,
    expectedA: 76, expectedB: 70,
    checkCommentA: 'Docker・AWS・PostgreSQL不足(2/5)と明記されるか',
    checkCommentB: 'React・TypeScript不足(2/4)と明記されるか',
  },
  {
    no: '③', label: '経験不足のみ', name: '山田 三郎',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 1, desiredRate: '70万', prefecture: '東京都', remoteAvailable: true,
    roles: null, selfPR: null, nationality: null,
    expectedA: 87, expectedB: 57,
    checkCommentA: '経験1年と短く要件未達と明記されるか',
    checkCommentB: 'スキル不足+経験1年が両方言及されるか',
  },
  {
    no: '④', label: '単価超過のみ', name: '山田 四朗',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '100万', prefecture: '東京都', remoteAvailable: true,
    roles: null, selfPR: null, nationality: null,
    expectedA: 85, expectedB: 55,
    checkCommentA: '単価100万が予算上限80万を大幅超過と明記されるか',
    checkCommentB: '単価100万が予算上限75万を大幅超過と明記されるか',
  },
  {
    no: '⑤', label: '地方×リモート不可', name: '山田 五郎',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '70万', prefecture: '北海道', remoteAvailable: false,
    roles: null, selfPR: null, nationality: null,
    expectedA: 70, expectedB: 70,
    checkCommentA: '北海道在住・リモート不可のため東京出社困難と明記されるか',
    checkCommentB: 'フルリモートのため勤務地問題なし、ただしスキル不足(React・TS)と言及されるか',
  },
  {
    no: '⑥', label: '地方×リモート可', name: '山田 六朗',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '70万', prefecture: '北海道', remoteAvailable: true,
    roles: null, selfPR: null, nationality: null,
    expectedA: 80, expectedB: 70,
    checkCommentA: '北海道在住だがリモート可。週2出社の移動負担に言及するか',
    checkCommentB: 'フルリモートで勤務地問題なし。スキル不足(React・TS)と言及されるか',
  },
  {
    no: '⑦', label: '人物像・希望職種ミスマッチ', name: '山田 七子',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '70万', prefecture: '東京都', remoteAvailable: true,
    roles: ['フロントエンド', 'UI/UX'],
    selfPR: 'フロントエンド専門。バックエンド業務は希望しない。',
    nationality: null,
    expectedA: 100, expectedB: 70,
    checkCommentA: 'スコア100だが本人フロントエンド希望・案件バックエンドリーダーとのミスマッチ懸念が出るか',
    checkCommentB: 'React・TS未習得なのに本人フロントエンド希望という矛盾に言及するか',
  },
  {
    no: '⑧', label: '外国籍（全合致）', name: '山田 八朗',
    skills: PROJ_A_SKILLS, skillLabelA: '5/5 (全合致)', skillLabelB: '2/4 (Java・SB)',
    experienceYears: 12, desiredRate: '70万', prefecture: '東京都', remoteAvailable: true,
    roles: ['バックエンド'],
    selfPR: '日本語ビジネスレベル。バックエンド専門。',
    nationality: '中国籍',
    expectedA: 100, expectedB: 70,
    checkCommentA: '全合致。中国籍のため国籍要件の確認が必要と言及するか',
    checkCommentB: 'React・TS不足。案件が日本国籍限定の可能性ありと言及するか',
  },
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
      setProgress('案件作成中... (1/2)')
      await insertProject({
        analyzed: {
          title: 'Javaバックエンドリーダー案件（東京・週3リモート可）[TEST]',
          client: null,
          description: 'Java/Spring Bootを使った業務システム開発のリーダーポジション。設計から実装・チームマネジメントまで担当。週3リモート可。テストデータ。',
          requiredSkills: PROJ_A_SKILLS,
          niceToHaveSkills: ['Kubernetes', 'Redis'],
          budgetMin: 60,
          budgetMax: 80,
          workLocation: '東京都',
          remotePolicy: '週3リモート可',
          roleSummary: 'チームリーダー経験者優遇。設計から実装まで担える方。',
          startDate: '2026-07-01',
        },
        rawText: 'Javaバックエンドリーダー案件 テストデータ',
        createdBy: `${nickname}(match-test)`,
        dataEnv,
      })

      setProgress('案件作成中... (2/2)')
      await insertProject({
        analyzed: {
          title: 'フルスタック開発案件（フルリモート・日本国籍限定）[TEST]',
          client: null,
          description: 'Java/Spring Bootバックエンド＋React/TypeScriptフロントエンドを担当。フルリモート勤務。日本国籍限定。テストデータ。',
          requiredSkills: PROJ_B_SKILLS,
          niceToHaveSkills: ['GraphQL', 'Next.js'],
          budgetMin: 55,
          budgetMax: 75,
          workLocation: '',
          remotePolicy: 'フルリモート',
          roleSummary: 'フロントエンドもこなせるフルスタックエンジニア希望。コミュニケーション力重視。',
          startDate: '2026-07-01',
        },
        rawText: 'フルスタック開発案件 テストデータ',
        createdBy: `${nickname}(match-test)`,
        dataEnv,
      })

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
            summary: `${row.label}テスト用。${row.skills.slice(0, 3).join('/')}経験${row.experienceYears}年。希望単価${row.desiredRate}。${row.selfPR ?? ''}`,
            prefecture: row.prefecture,
            remoteAvailable: row.remoteAvailable,
            desiredRate: row.desiredRate,
            nationality: row.nationality,
            roles: row.roles ?? undefined,
            selfPR: row.selfPR,
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
      <div className="flex items-center gap-2 mb-2">
        <FlaskConical size={16} className="text-indigo-600" />
        <span className="text-sm font-semibold text-indigo-800">マッチングテストデータ生成</span>
      </div>

      <div className="text-xs text-indigo-700 mb-2 space-y-0.5">
        <p>スコアリング全観点（スキル・経験・単価・勤務地・リモート・人物像・本人希望・国籍）を2案件 × 8人材で一括検証。</p>
        <p>
          <span className="font-semibold">案件A</span>: Javaバックエンドリーダー（東京・週3リモート・必須5スキル・60〜80万）
          <span className="mx-1 text-indigo-400">｜</span>
          <span className="font-semibold">案件B</span>: フルスタック（フルリモート・日本国籍限定・必須4スキル・55〜75万）
        </p>
      </div>

      {/* テスト計画表（常時表示） */}
      <div className="overflow-x-auto">
        <table className="text-xs w-full border border-indigo-200 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-indigo-100 text-indigo-800">
              <th className="px-2 py-1.5 text-left">No</th>
              <th className="px-2 py-1.5 text-left">テスト観点</th>
              <th className="px-2 py-1.5 text-left">名前</th>
              <th className="px-2 py-1.5 text-left">スキルA</th>
              <th className="px-2 py-1.5 text-left">スキルB</th>
              <th className="px-2 py-1.5 text-center">経験</th>
              <th className="px-2 py-1.5 text-center">単価</th>
              <th className="px-2 py-1.5 text-center">居住</th>
              <th className="px-2 py-1.5 text-center">リモート</th>
              <th className="px-2 py-1.5 text-left">希望職種・PR</th>
              <th className="px-2 py-1.5 text-center">国籍</th>
              <th className="px-2 py-1.5 text-center">期待A</th>
              <th className="px-2 py-1.5 text-center">期待B</th>
              <th className="px-2 py-1.5 text-left">AIコメントA確認ポイント</th>
              <th className="px-2 py-1.5 text-left">AIコメントB確認ポイント</th>
            </tr>
          </thead>
          <tbody>
            {TEST_ROWS.map((row) => (
              <tr key={row.no} className="border-t border-indigo-100 bg-white even:bg-indigo-50/40 align-top">
                <td className="px-2 py-1.5 text-indigo-700 font-mono whitespace-nowrap">{row.no}</td>
                <td className="px-2 py-1.5 text-gray-700 whitespace-nowrap">{row.label}</td>
                <td className="px-2 py-1.5 text-gray-800 whitespace-nowrap">{row.name}</td>
                <td className="px-2 py-1.5 text-gray-700 whitespace-nowrap">{row.skillLabelA}</td>
                <td className="px-2 py-1.5 text-gray-700 whitespace-nowrap">{row.skillLabelB}</td>
                <td className="px-2 py-1.5 text-center text-gray-700 whitespace-nowrap">{row.experienceYears}年</td>
                <td className="px-2 py-1.5 text-center text-gray-700 whitespace-nowrap">{row.desiredRate}</td>
                <td className="px-2 py-1.5 text-center text-gray-700 whitespace-nowrap">{row.prefecture}</td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  {row.remoteAvailable
                    ? <span className="text-green-600 font-semibold">可</span>
                    : <span className="text-red-500 font-semibold">不可</span>}
                </td>
                <td className="px-2 py-1.5 min-w-[140px]">
                  {row.roles && <div className="text-indigo-600 font-medium">{row.roles.join('・')}</div>}
                  {row.selfPR && <div className="text-gray-500 italic">{row.selfPR.slice(0, 25)}…</div>}
                  {!row.roles && !row.selfPR && <span className="text-gray-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  {row.nationality
                    ? <span className="text-orange-600 font-medium">{row.nationality}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className={`px-2 py-1.5 text-center whitespace-nowrap ${scoreColor(row.expectedA)}`}>{row.expectedA}</td>
                <td className={`px-2 py-1.5 text-center whitespace-nowrap ${scoreColor(row.expectedB)}`}>{row.expectedB}</td>
                <td className="px-2 py-1.5 text-gray-600 min-w-[180px] leading-relaxed">{row.checkCommentA}</td>
                <td className="px-2 py-1.5 text-gray-600 min-w-[180px] leading-relaxed">{row.checkCommentB}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-indigo-500 mt-1.5 mb-3 flex flex-wrap gap-x-3">
        <span>スコア凡例: <span className="text-green-700 font-semibold">80+</span> / <span className="text-blue-700 font-semibold">60-79</span> / <span className="text-yellow-700 font-semibold">40-59</span> / <span className="text-red-600 font-semibold">40未満</span></span>
        <span>※スキルA=案件A必須5中の合致 / スキルB=案件B必須4中の合致</span>
      </div>

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
        <div className="mt-3 flex items-center gap-2 text-green-700 text-sm">
          <CheckCircle2 size={14} />
          <span>生成完了（2案件 + 8人材）。マッチング画面でテスト案件を選択してAIコメントを確認してください。</span>
        </div>
      )}
    </div>
  )
}
