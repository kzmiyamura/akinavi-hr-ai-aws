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
import { buildGridInput, normTech } from './lib.mjs'
import { extractProjects, extractBodyFields } from './run.mjs'
import { buildPatch, pickBodyFieldsFor, mergeSkills, techsFromProjects, SKILLS_REPLACE } from './apply.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください'); process.exit(1) }

const STATE_FILE = path.join(os.homedir(), '.akinavi_shadow_state.json')
const CYCLE_MS = 5 * 60 * 1000
const MAX_PER_CYCLE = 15        // 1サイクルのLLM対象候補者上限
const MAX_PER_DAY = 400         // 日次上限（サブスク枠保護）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akinavi-shadow-'))
// 本番 candidates への上書き。SHADOW_APPLY=0 で記録のみ（シャドー運転）に戻せる
const APPLY = process.env.SHADOW_APPLY !== '0'

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
  // PostgREST のPOST(upsert)は 201 + 空ボディを返す。空はnull扱いにする
  const text = await res.text()
  return text.trim() ? JSON.parse(text) : null
}

async function saveShadow(row) {
  await rest('llm_shadow?on_conflict=candidate_id,source', {
    method: 'POST', body: JSON.stringify(row),
  })
}

/** skill_master 全件を正規化キー集合として1度だけ読み込む（skills 追加判定用） */
let _skillMaster = null
async function skillMasterSet() {
  if (_skillMaster) return _skillMaster
  const s = new Set()
  for (let from = 0; ; from += 1000) {
    const rows = await rest(`skill_master?select=name,aliases&limit=1000&offset=${from}`)
    if (!rows?.length) break
    for (const r of rows) {
      for (const n of [r.name, ...(r.aliases || [])]) { const k = normTech(n); if (k) s.add(k) }
    }
    if (rows.length < 1000) break
  }
  _skillMaster = s
  log(`skill_master 読み込み ${s.size}語`)
  return s
}

/** LLM の抽出結果を本番 candidates に反映する */
async function applyToCandidate(c, { bodyFields, attachment }) {
  const { patch, changes } = buildPatch(c, { bodyFields, attachment })
  if (!patch) { log(`  [${c.name}] 変更なし（DB更新スキップ）`); return }

  // skills は skill_master にある未登録スキルの追加のみ（工程スキル等を消さないため）
  if (attachment?.projects?.length) {
    const techs = techsFromProjects(attachment.projects)
    if (SKILLS_REPLACE) {
      patch.skills = techs
      changes.push('skills(全置換)')
    } else {
      const merged = mergeSkills(c.skills, techs, await skillMasterSet())
      if (merged) { patch.skills = merged; changes.push(`skills(+${merged.length - (c.skills?.length ?? 0)})`) }
    }
  }

  await rest(`candidates?id=eq.${c.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  })
  log(`  [${c.name}] 上書き: ${changes.join(', ')}`)
}

async function processCandidate(c) {
  let bodyFields = null, attachment = null

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
      // 複数人メールでは自分の行だけを選ぶ。特定できなければ本文由来は上書きしない
      bodyFields = pickBodyFieldsFor(c.name, bf.candidates)
      if (!bodyFields && (bf.candidates?.length ?? 0) > 1) {
        log(`  [${c.name}] 本文に複数人・特定不可のため本文フィールドは上書きせず`)
      }
    } catch (e) {
      await saveShadow({ candidate_id: c.id, source: 'body', status: 'error', reasons: [String(e).slice(0, 200)] })
    }
  }

  // 経歴書（Haiku→検証→Sonnet）
  const url = c.resume_url
  if (url && /\.xlsx?$/i.test(url)) {
    const fp = path.join(TMP, `${c.id}.xlsx`)
    try {
      let res = await fetch(url).catch(() => null)
      if (!res || !res.ok) { await new Promise(r => setTimeout(r, 3000)); res = await fetch(url) }
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
      attachment = { projects: r.projects, skill_years: r.skillYears, model: r.model, status: r.status }
    } catch (e) {
      await saveShadow({ candidate_id: c.id, source: 'attachment', status: 'error', reasons: [String(e).slice(0, 200)] })
    } finally {
      fs.rmSync(fp, { force: true })
    }
  }

  if (APPLY && (bodyFields || attachment)) {
    try { await applyToCandidate(c, { bodyFields, attachment }) }
    catch (e) { log(`  [${c.name}] 上書き失敗:`, String(e).slice(0, 200)) }
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

log(`ワーカー起動 mode=${APPLY ? '本番上書き' : 'シャドー記録のみ'} watermark=${state.watermark} 上限=${MAX_PER_CYCLE}/cycle, ${MAX_PER_DAY}/day`)
while (true) {
  try { await cycle() } catch (e) { log('cycle error:', String(e).slice(0, 300)) }
  await new Promise(r => setTimeout(r, CYCLE_MS))
}
