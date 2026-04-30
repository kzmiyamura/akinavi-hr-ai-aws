// Vercel Serverless Function: Make.com → AI解析 → Supabase保存
// POST /api/analyze
// Body: { type: 'candidate' | 'project', from, subject, body }

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createClient } from '@supabase/supabase-js'

function getEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`環境変数 ${key} が設定されていません`)
  return val
}

async function generateJSON(prompt: string): Promise<unknown> {
  const genAI = new GoogleGenerativeAI(getEnv('GEMINI_API_KEY'))
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
  const result = await model.generateContent(prompt)
  const raw = result.response.text()
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  return JSON.parse(cleaned)
}

function extractEmail(from: string): string | null {
  const match = from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)
  return match ? match[0] : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { type = 'candidate', from = '', subject = '', body = '' } = req.body ?? {}

    if (!String(body).trim()) {
      return res.status(400).json({ error: 'メール本文が空です' })
    }

    const supabase = createClient(
      getEnv('SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    )

    // ── 人材メール解析 ────────────────────────────────────────
    if (type === 'candidate') {
      const analyzed = await generateJSON(`
以下のメール本文から人材情報を抽出し、JSON形式のみで返してください。

差出人: ${from}
件名: ${subject}

抽出項目:
- name: string（氏名。不明なら "不明"）
- email: string | null
- phone: string | null
- skills: string[]（スキル・資格・言語等。空なら[]）
- experienceYears: number | null
- summary: string（200字以内）

本文:
${String(body).slice(0, 3000)}

JSON:`.trim()) as {
        name: string; email: string | null; phone: string | null
        skills: string[]; experienceYears: number | null; summary: string
      }

      const email = analyzed.email || extractEmail(String(from))
      const dbPayload = {
        name: analyzed.name ?? '不明',
        email,
        phone: analyzed.phone ?? null,
        skills: analyzed.skills ?? [],
        experience_years: analyzed.experienceYears ?? null,
        raw_profile: {
          text: String(body).slice(0, 5000),
          summary: analyzed.summary ?? '',
          from, subject,
        },
        duplicate_flag: false,
        created_by: 'make-inbound',
      }

      const { data, error } = email
        ? await supabase.from('candidates').upsert(dbPayload, { onConflict: 'email' }).select().single()
        : await supabase.from('candidates').insert(dbPayload).select().single()

      if (error) throw new Error(`候補者保存エラー: ${error.message}`)
      return res.status(200).json({ ok: true, type: 'candidate', id: data.id, name: data.name })
    }

    // ── 案件メール解析 ────────────────────────────────────────
    if (type === 'project') {
      const analyzed = await generateJSON(`
以下のメール本文から案件情報を抽出し、JSON形式のみで返してください。

差出人: ${from}
件名: ${subject}

抽出項目:
- title: string（案件名。不明なら "案件"）
- client: string | null
- description: string
- requiredSkills: string[]（空なら[]）
- budgetMin: number | null（月額・万円。不明ならnull）
- budgetMax: number | null（月額・万円。不明ならnull）

本文:
${String(body).slice(0, 3000)}

JSON:`.trim()) as {
        title: string; client: string | null; description: string
        requiredSkills: string[]; budgetMin: number | null; budgetMax: number | null
      }

      const { data, error } = await supabase.from('projects').insert({
        title: analyzed.title ?? '案件',
        client: analyzed.client ?? null,
        description: analyzed.description ?? '',
        required_skills: analyzed.requiredSkills ?? [],
        budget_min: analyzed.budgetMin ?? null,
        budget_max: analyzed.budgetMax ?? null,
        raw_data: { text: String(body).slice(0, 5000), from, subject },
        created_by: 'make-inbound',
      }).select().single()

      if (error) throw new Error(`案件保存エラー: ${error.message}`)
      return res.status(200).json({ ok: true, type: 'project', id: data.id, title: data.title })
    }

    return res.status(400).json({ error: `不明な type: ${type}` })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[/api/analyze] エラー:', message)
    return res.status(500).json({ ok: false, error: message })
  }
}
