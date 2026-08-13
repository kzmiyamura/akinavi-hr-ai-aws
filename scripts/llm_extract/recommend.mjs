#!/usr/bin/env node
// 案件×候補者の「推薦所見」を Claude(Haiku) で作る。既定はドライラン（DBを変えない）。
//
// 点数だけでは営業が使えないため（2026-08-13 指摘）、案件本文と経歴の両方を読ませ、
// 「この案件はこういう人でないと通らない」「この方はこの経験が効く」「ここが足りない」を出す。
//
// 使い方:
//   node scripts/llm_extract/recommend.mjs --project <uuid>            # 上位3名をドライラン
//   node scripts/llm_extract/recommend.mjs --project <uuid> --top 5    # 件数を変える
//   node scripts/llm_extract/recommend.mjs --project <uuid> --run      # submissions に書き込む
//   node scripts/llm_extract/recommend.mjs --project <uuid> --candidate <uuid>  # 1名だけ
//
// 費用: claude -p（Max サブスク枠）。API課金は発生しないが5時間枠を消費するため、
// 既定の対象は上位3名まで。多数を回すときは --top を明示すること。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { extractRecommendation } from './run.mjs'

for (const line of readFileSync(join(homedir(), '.akinavi_shadow.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '')
}
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY がありません'); process.exit(1) }

const args = process.argv.slice(2)
const RUN = args.includes('--run')
const valOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null }
const PROJECT_ID = valOf('--project')
const CANDIDATE_ID = valOf('--candidate')
const TOP = Number(valOf('--top') ?? 3)
if (!PROJECT_ID) { console.error('--project <uuid> が要ります'); process.exit(1) }

async function rest(pathq, opts = {}) {
  const res = await fetch(`${URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const t = await res.text()
  return t.trim() ? JSON.parse(t) : null
}

/** 案件をAIに渡すテキストに整える。本文があれば本文が正（項目は抽出済みの再掲） */
function projectText(p) {
  const rd = p.raw_data ?? {}
  const head = [
    `案件名: ${p.title ?? ''}`,
    p.client ? `クライアント: ${p.client}` : null,
    `必須スキル: ${((p.required_skills ?? [])).join('、') || 'なし'}`,
    rd.niceToHaveSkills?.length ? `尚可スキル: ${rd.niceToHaveSkills.join('、')}` : null,
    p.work_location ? `勤務地: ${p.work_location}` : null,
    p.remote_policy ? `リモート: ${p.remote_policy}` : null,
    p.contract_type ? `契約形態: ${p.contract_type}` : null,
    p.budget_max != null ? `単価上限: ${p.budget_max}万円` : null,
  ].filter(Boolean).join('\n')
  const body = String(rd.text ?? '')
  return body.length > 50 ? `${head}\n\n--- 元メール本文 ---\n${body}` : head
}

/** 候補者をAIに渡すテキストに整える。経歴本文があればそれを使う */
function candidateText(c) {
  const rp = c.raw_profile ?? {}
  const head = [
    `氏名: ${c.name ?? ''}`,
    c.experience_years != null ? `総経験年数: ${c.experience_years}年` : null,
    c.desired_rate ? `希望単価: ${c.desired_rate}` : null,
    c.from_company ? `所属: ${c.from_company}` : null,
    `保有スキル: ${((c.skills ?? [])).join('、') || 'なし'}`,
  ].filter(Boolean).join('\n')
  const body = String(rp.attachmentText ?? rp.text ?? '')
  return body.length > 50 ? `${head}\n\n--- 経歴書・メール本文 ---\n${body}` : head
}

const [p] = await rest(`projects?select=id,title,client,required_skills,raw_data,work_location,remote_policy,contract_type,budget_max&id=eq.${PROJECT_ID}`) ?? []
if (!p) { console.error('案件が見つかりません'); process.exit(1) }
console.log(`■ ${p.title}\n`)

// 対象の submission を上位から取る。ai_raw を丸ごと取ると重いので必要な列だけ
const subQ = `submissions?select=id,candidate_id,match_score&project_id=eq.${PROJECT_ID}`
  + (CANDIDATE_ID ? `&candidate_id=eq.${CANDIDATE_ID}` : '')
  + `&order=match_score.desc&limit=${CANDIDATE_ID ? 1 : TOP}`
const subs = await rest(subQ)
if (!subs?.length) { console.error('この案件のマッチング結果がありません。先に「再マッチング」を実行してください'); process.exit(1) }

const pText = projectText(p)
for (const sub of subs) {
  const [c] = await rest(`candidates?select=id,name,skills,experience_years,desired_rate,from_company,raw_profile&id=eq.${sub.candidate_id}`) ?? []
  if (!c) { console.log(`（候補者 ${sub.candidate_id} が見つかりません）\n`); continue }
  const r = await extractRecommendation(pText, candidateText(c))
  console.log(`― ${c.name}（スコア ${sub.match_score}）  判断: ${r.verdict ?? '—'}  確信度: ${r.confidence}`)
  if (r.required) console.log(`  案件が求める人: ${r.required}`)
  if (r.pitch) console.log(`  後押し: ${r.pitch}`)
  for (const s of r.strengths) console.log(`  効く経験: ${s.point}${s.evidence ? `（根拠: ${s.evidence}）` : ''}`)
  for (const g of r.gaps) console.log(`  足りない点: ${g}`)

  // 確信度が low でも書く。実データではモデルが保守的に low を付けるが内容は使えた
  // （2026-08-13 実測）。画面側で「確信度：低」と出して営業に判断させる
  if (RUN && r.pitch) {
    const [cur] = await rest(`submissions?select=ai_raw&id=eq.${sub.id}`) ?? []
    const aiRaw = { ...(cur?.ai_raw ?? {}) }
    aiRaw.recommendation = {
      at: new Date().toISOString(),
      model: r.model,
      required: r.required, verdict: r.verdict, pitch: r.pitch,
      strengths: r.strengths, gaps: r.gaps, confidence: r.confidence,
    }
    await rest(`submissions?id=eq.${sub.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ai_raw: aiRaw }),
    })
    console.log('  → 書き込み済み')
  } else if (RUN) {
    console.log('  → 低確信のため書き込みません')
  }
  console.log('')
}
