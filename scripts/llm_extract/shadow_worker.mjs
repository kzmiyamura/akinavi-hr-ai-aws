#!/usr/bin/env node
// llm_extract/shadow_worker.mjs — LLM抽出シャドーワーカー（1日運転用）
//
// 本番regexパイプラインが作った新規候補者を5分おきにポーリングし、
// 同じ入力（経歴書xlsx・メール本文）を LLMルーター(Haiku→検証→Sonnet)で解析して
// llm_shadow テーブルに並記録する。本番フィールドには一切書き込まない。
//
// 起動:
//   source ~/.akinavi_shadow.env   # SUPABASE_URL / SUPABASE_SERVICE_KEY
//   nohup node scripts/llm_extract/shadow_worker.mjs >> ~/akinavi_shadow.log 2>&1 & disown
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildGridInput } from './lib.mjs'
import { extractProjects, extractBodyFields } from './run.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください'); process.exit(1) }

const STATE_FILE = path.join(os.homedir(), '.akinavi_shadow_state.json')
const CYCLE_MS = 5 * 60 * 1000
const MAX_PER_CYCLE = 15        // 1サイクルのLLM対象候補者上限
const MAX_PER_DAY = 400         // 日次上限（サブスク枠保護）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akinavi-shadow-'))

const log = (...a) => console.log(new Date().toISOString(), ...a)
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { watermark: new Date().toISOString(), day: '', dayCount: 0, dayCost: 0 }
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state))

async function rest(pathq, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathq}`, {
    ...opts,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`${pathq} -> ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? null : res.json()
}

async function saveShadow(row) {
  await rest('llm_shadow?on_conflict=candidate_id,source', {
    method: 'POST', body: JSON.stringify(row),
  })
}

async function processCandidate(c) {
  // 本文フィールド（常にHaiku）
  const bodyText = c.raw_profile?.text ?? ''
  if (bodyText.length > 50) {
    try {
      const t0 = Date.now()
      const bf = await extractBodyFields(bodyText.slice(0, 8000))
      await saveShadow({
        candidate_id: c.id, source: 'body', model: bf.model, status: 'ok',
        body_fields: bf.candidates, cost_usd: bf.costUsd, ms: Date.now() - t0,
      })
      state.dayCost += bf.costUsd || 0
    } catch (e) {
      await saveShadow({ candidate_id: c.id, source: 'body', status: 'error', reasons: [String(e).slice(0, 200)] })
    }
  }

  // 経歴書（Haiku→検証→Sonnet）
  const url = c.resume_url
  if (url && /\.xlsx?$/i.test(url)) {
    const fp = path.join(TMP, `${c.id}.xlsx`)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`resume DL ${res.status}`)
      fs.writeFileSync(fp, Buffer.from(await res.arrayBuffer()))
      const grid = buildGridInput(fp)
      if (!grid) throw new Error('no date cells in workbook')
      const r = await extractProjects(grid, { log: m => log(`  [${c.name}]`, m) })
      await saveShadow({
        candidate_id: c.id, source: 'attachment', model: r.model, status: r.status,
        reasons: r.reasons, projects: r.projects, skill_years: r.skillYears,
        cost_usd: r.costUsd, ms: r.ms,
      })
      state.dayCost += r.costUsd || 0
    } catch (e) {
      await saveShadow({ candidate_id: c.id, source: 'attachment', status: 'error', reasons: [String(e).slice(0, 200)] })
    } finally {
      fs.rmSync(fp, { force: true })
    }
  }
}

async function cycle() {
  const today = new Date().toISOString().slice(0, 10)
  if (state.day !== today) { state.day = today; state.dayCount = 0; state.dayCost = 0 }
  if (state.dayCount >= MAX_PER_DAY) { log(`日次上限${MAX_PER_DAY}到達、スキップ`); return }

  const q = `candidates?select=id,name,resume_url,raw_profile,created_at` +
    `&data_env=eq.prod&created_at=gt.${encodeURIComponent(state.watermark)}` +
    `&order=created_at.asc&limit=${MAX_PER_CYCLE}`
  const rows = await rest(q)
  if (!rows.length) { log('新規なし'); return }
  log(`新規候補者 ${rows.length}件`)

  for (const c of rows) {
    log(`処理: ${c.name} (${c.id})`)
    await processCandidate(c)
    state.watermark = c.created_at
    state.dayCount++
    saveState()
  }
  log(`サイクル完了 day=${state.dayCount}件 cost=$${state.dayCost.toFixed(2)}`)
}

log(`シャドーワーカー起動 watermark=${state.watermark} 上限=${MAX_PER_CYCLE}/cycle, ${MAX_PER_DAY}/day`)
while (true) {
  try { await cycle() } catch (e) { log('cycle error:', String(e).slice(0, 300)) }
  await new Promise(r => setTimeout(r, CYCLE_MS))
}
