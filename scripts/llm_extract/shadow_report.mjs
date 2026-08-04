#!/usr/bin/env node
// llm_extract/shadow_report.mjs — シャドー運転の regex vs LLM 突き合わせレポート
// 使い方: source ~/.akinavi_shadow.env && node scripts/llm_extract/shadow_report.mjs [日数=1]
import { normTech } from './lib.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const days = Number(process.argv[2] ?? 1)

async function rest(q) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const since = new Date(Date.now() - days * 86400e3).toISOString()
const shadows = await rest(`llm_shadow?select=*&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc`)
const candIds = [...new Set(shadows.map(s => s.candidate_id))]
const cands = candIds.length
  ? await rest(`candidates?select=id,name,raw_profile,resume_url&id=in.(${candIds.join(',')})`)
  : []
const byId = Object.fromEntries(cands.map(c => [c.id, c]))

const att = shadows.filter(s => s.source === 'attachment')
const body = shadows.filter(s => s.source === 'body')
const stats = {
  candidates: candIds.length,
  attachment: { total: att.length, ok: 0, needs_review: 0, error: 0, haiku: 0, sonnet: 0 },
  body: { total: body.length, ok: body.filter(b => b.status === 'ok').length, error: body.filter(b => b.status === 'error').length },
  costUsd: shadows.reduce((a, s) => a + (+s.cost_usd || 0), 0),
}
const details = []
for (const s of att) {
  stats.attachment[s.status] = (stats.attachment[s.status] ?? 0) + 1
  if (s.model) stats.attachment[s.model] = (stats.attachment[s.model] ?? 0) + 1
  const c = byId[s.candidate_id]
  if (!c || s.status === 'error') { details.push({ name: c?.name, status: s.status, err: s.reasons }); continue }
  // regex側 skillYears と比較
  const regexSY = c.raw_profile?.skillYears ?? {}
  const rk = new Set(Object.keys(regexSY).filter(k => !k.startsWith('_')).map(normTech))
  const lk = new Set(Object.keys(s.skill_years ?? {}).map(normTech))
  const both = [...rk].filter(k => lk.has(k))
  // 値の比較（両方にあるキー）
  const lmap = Object.fromEntries(Object.entries(s.skill_years ?? {}).map(([k, v]) => [normTech(k), v]))
  const rmap = Object.fromEntries(Object.entries(regexSY).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [normTech(k), v]))
  const valAgree = both.filter(k => Math.abs(lmap[k] - rmap[k]) <= Math.max(3, rmap[k] * 0.15)).length
  details.push({
    name: c.name, model: s.model, status: s.status,
    regexKeys: rk.size, llmKeys: lk.size, common: both.length,
    llmOnly: lk.size - both.length, regexOnly: rk.size - both.length,
    valAgree: both.length ? +(valAgree / both.length).toFixed(2) : null,
    reasons: (s.reasons ?? []).join('|') || undefined,
  })
}

console.log(JSON.stringify({ since, stats, details }, null, 1))
