import { useState } from 'react'
import { Loader2, Users } from 'lucide-react'
import { GoogleGenerativeAI } from '@google/generative-ai'
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

interface DemoCandidate {
  label: string
  targetScore: number
  name: string
  skills: string[]
  experienceYears: number
  desiredRate: string
  prefecture: string
  availableRegions: string[]
  remoteAvailable: boolean
  summary: string
}

async function generateDemoCandidates(project: Project): Promise<DemoCandidate[]> {
  const key = import.meta.env.VITE_GEMINI_API_KEY as string
  if (!key) throw new Error('VITE_GEMINI_API_KEY が設定されていません')

  const genAI = new GoogleGenerativeAI(key)
  const model = genAI.getGenerativeModel({
    model: (import.meta.env.VITE_GEMINI_MODEL as string | undefined)?.trim() ?? 'gemini-2.5-flash-lite',
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096, responseMimeType: 'application/json' },
  })

  const prompt = `以下の案件情報をもとに、マッチング度が異なる架空のITエンジニア5名を生成してください。
人物は実在しない架空の日本人にしてください。

【案件情報】
タイトル: ${project.title}
必須スキル: ${(project.required_skills as string[] ?? []).join(', ')}
勤務地: ${project.work_location ?? '未指定'}
リモートポリシー: ${project.remote_policy ?? '未指定'}
予算: ${project.budget_min ?? '?'}〜${project.budget_max ?? '?'}万円
説明: ${project.description ?? ''}

【生成ルール】
1番目（90点相当 = 超マッチ）: 必須スキルをほぼすべて持ち、経験10年以上、単価も予算内
2番目（70点相当 = まあまあ合う）: 必須スキルの7割程度を持ち、経験5〜8年、単価は少し高め
3番目（50点相当 = 少し合う）: 必須スキルの半分程度を持ち、経験3〜5年、単価は予算上限付近
4番目（30点相当 = あまり合わない）: 必須スキルと1〜2個だけ重複、別分野メイン、経験2〜3年
5番目（10点相当 = 全く合わない）: 必須スキルとほぼ重複なし、全く別分野、経験1〜2年

各人材のskillsは実際のITスキル名（Java, TypeScript等）を使ってください。
desiredRateは「60万」「75万」のような形式で。
prefectureは都道府県名のみ（例: 東京都、神奈川県）。
availableRegionsは希望勤務地の都道府県リスト（1〜3件）。
summaryは100字以内の職務要約。

JSON配列のみ返す:
[
  {
    "label": "超マッチ（90点相当）",
    "targetScore": 90,
    "name": "姓 名",
    "skills": ["スキル1", "スキル2"],
    "experienceYears": 12,
    "desiredRate": "65万",
    "prefecture": "東京都",
    "availableRegions": ["東京都", "神奈川県"],
    "remoteAvailable": true,
    "summary": "職務要約100字以内"
  },
  ...
]`

  const result = await model.generateContent(prompt)
  const raw = result.response.text()
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned) as DemoCandidate[]
}

const SCORE_COLORS: Record<number, string> = {
  90: 'bg-green-100 text-green-800',
  70: 'bg-blue-100 text-blue-800',
  50: 'bg-yellow-100 text-yellow-800',
  30: 'bg-orange-100 text-orange-800',
  10: 'bg-red-100 text-red-800',
}

export function DemoProjectCandidateGen({ project, nickname, dataEnv, onDone }: Props) {
  const [status, setStatus] = useState<'idle' | 'generating' | 'saving' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [generatedNames, setGeneratedNames] = useState<Array<{ label: string; name: string; score: number }>>([])

  async function handleGenerate() {
    setStatus('generating')
    setMessage(null)
    setGeneratedNames([])

    try {
      const candidates = await generateDemoCandidates(project)
      setStatus('saving')

      const results: typeof generatedNames = []
      for (const c of candidates) {
        const analyzed: AnalyzeCandidateResponse = {
          name: c.name,
          email: null,
          phone: null,
          skills: c.skills,
          experienceYears: c.experienceYears,
          summary: c.summary,
          prefecture: c.prefecture,
          availableRegions: c.availableRegions,
          remoteAvailable: c.remoteAvailable,
          roles: [],
          industries: [],
        }
        // raw_profileにdesiredRateを含める
        const rawProfile = {
          text: `デモ人材: ${c.name}\nスキル: ${c.skills.join(', ')}\n経験: ${c.experienceYears}年\n希望単価: ${c.desiredRate}\n${c.summary}`,
          summary: c.summary,
          desiredRate: c.desiredRate,
          prefecture: c.prefecture,
          availableRegions: c.availableRegions,
          remoteAvailable: c.remoteAvailable,
        }

        await upsertCandidate({
          analyzed,
          rawText: rawProfile.text,
          createdBy: `${nickname}(demo-gen)`,
          dataEnv,
          duplicateSuspected: false,
        })
        results.push({ label: c.label, name: c.name, score: c.targetScore })
      }

      setGeneratedNames(results)
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
          disabled={status === 'generating' || status === 'saving'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {(status === 'generating' || status === 'saving') ? (
            <><Loader2 size={12} className="animate-spin" />{status === 'generating' ? 'AI生成中...' : '保存中...'}</>
          ) : (
            <>スコア別5人を生成</>
          )}
        </button>
      </div>

      {status === 'done' && generatedNames.length > 0 && (
        <div className="space-y-1">
          {generatedNames.map((r) => (
            <div key={r.name} className="flex items-center gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded font-medium ${SCORE_COLORS[r.score] ?? 'bg-gray-100 text-gray-700'}`}>
                {r.score}点
              </span>
              <span className="text-gray-700">{r.label.replace(/（.*）/, '')} — {r.name}</span>
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
