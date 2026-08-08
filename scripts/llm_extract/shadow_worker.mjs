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
import { buildGridInput, buildTextGridInput, normTech } from './lib.mjs'
import { extractProjects, extractBodyFields } from './run.mjs'
import { buildPatch, pickBodyFieldsFor, mergeSkills, techsFromProjects, SKILLS_REPLACE } from './apply.mjs'
import { downloadBoxFile } from './box_fetch.mjs'

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
      if (bodyFields) bodyFields._model = bf.model  // _llm_applied.model 記録用（buildPatch が参照）
      if (!bodyFields && (bf.candidates?.length ?? 0) > 1) {
        log(`  [${c.name}] 本文に複数人・特定不可のため本文フィールドは上書きせず`)
      }
    } catch (e) {
      await saveShadow({ candidate_id: c.id, source: 'body', status: 'error', reasons: [String(e).slice(0, 200)] })
    }
  }

  // 経歴書（Haiku→検証→Sonnet）。xlsx系はグリッド、docx/pdfはテキスト行で抽出
  const url = c.resume_url
  const extMatch = url ? url.toLowerCase().match(/\.(xlsx?|xlsm|docx|pdf)$/) : null
  if (extMatch) {
    const ext = extMatch[1]
    const fp = path.join(TMP, `${c.id}.${ext}`)
    try {
      let res = await fetch(url).catch(() => null)
      if (!res || !res.ok) { await new Promise(r => setTimeout(r, 3000)); res = await fetch(url) }
      if (!res.ok) throw new Error(`resume DL ${res.status}`)
      fs.writeFileSync(fp, Buffer.from(await res.arrayBuffer()))
      let grid, kind = 'grid'
      if (ext === 'docx' || ext === 'pdf') {
        const { extractResumeText } = await import('./textract.mjs')
        grid = buildTextGridInput(await extractResumeText(fp, ext), ext)
        kind = 'text'
      } else {
        grid = buildGridInput(fp)
      }
      if (!grid) throw new Error(`no date cells in ${ext}`)
      const r = await extractProjects(grid, { log: m => log(`  [${c.name}]`, m), kind })
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

  // buildPatch / mergeSkills が参照するトップレベル列は必ず select に含めること。
  // 欠けると「既存値なし」と誤認して fill 項目まで上書き・skills 全置換になる（2026-08-08 に実害）
  const q = `candidates?select=id,name,resume_url,raw_profile,created_at,desired_rate,from_company,experience_years,skills` +
    `&data_env=eq.prod&created_at=gt.${encodeURIComponent(state.watermark)}` +
    `&order=created_at.asc&limit=${MAX_PER_CYCLE}`
  const rows = await rest(q)
  if (!rows.length) { log('新規なし'); return }
  log(`新規候補者 ${rows.length}件`)

  for (const c of rows) {
    // 再解析（Box取込・UI再解析ボタン）は created_at を now にリセットするため、
    // 処理済み候補者が「新規」として再登場する。LLM適用が created_at より後なら処理済み
    const ap = c.raw_profile?._llm_applied
    if (ap?.at && new Date(ap.at) >= new Date(c.created_at)) {
      log(`スキップ（再解析後LLM適用済み）: ${c.name}`)
      state.watermark = c.created_at
      saveState()
      continue
    }
    log(`処理: ${c.name} (${c.id})`)
    await processCandidate(c)
    state.watermark = c.created_at
    state.dayCount++
    saveState()
  }
  log(`サイクル完了 day=${state.dayCount}件 cost=$${state.dayCost.toFixed(2)}`)
}

// ── Box経歴書再解析キュー ──
// 対象: ①UI「AI取込」ボタン（box_status='fetch_requested'、全env）
//       ②全自動取込（box_status='pending' かつ resume_url なし、prodのみ・2026-08-08ユーザー判断）
// 流れ: Box からDL → inbound-email Edge Function に「元メール本文＋添付」で再解析依頼
// （regex再解析・storage保存・resume_url付与）→ LLM 再解析（processCandidate）→ 'enriched'。
// UI応答性のため本サイクル(5分)とは別に30秒間隔でポーリングする。
//
// 注意（2026-08-08 の実害から）:
// - 合成本文（Box経歴書ファイル取込:...）を送ると regex が「Box経歴書」を会社名として抽出し、
//   さらに inbound-email の UPDATE が desired_rate 等の本文由来フィールドを消す。
//   必ず元メール本文・元件名を送る（UI再解析ボタンと同じ流儀）。
// - 複数人メール由来の人材は再解析すると block[0] が target_candidate_id に強制適用され
//   別人のデータが混ざるためスキップする（同一 from+件名 の兄弟レコードで判定）
const BOX_POLL_MS = 30 * 1000
const CAND_SELECT = 'id,name,resume_url,raw_profile,created_at,desired_rate,from_company,experience_years,skills'
const BOX_SELECT = 'id,name,box_url,data_env,from_company,desired_rate,' +
  'mailfrom:raw_profile->>from,subject:raw_profile->>subject,body:raw_profile->>text'
const AUTO_BOX_PER_POLL = 2   // 全自動取込は1ポーリング2人まで（手動依頼を優先）

/** 同一メール（from+件名）から複数人が登録されていたら true（再解析でデータ混線するため除外） */
async function hasSiblings(c) {
  if (!c.mailfrom || !c.subject) return false
  const q = `candidates?select=id&raw_profile->>from=eq.${encodeURIComponent(c.mailfrom)}` +
    `&raw_profile->>subject=eq.${encodeURIComponent(c.subject)}&data_env=eq.${c.data_env}&limit=2`
  const rows = await rest(q)
  return (rows?.length ?? 0) > 1
}

async function processBoxCandidate(c) {
  log(`Box取得: ${c.name} (${c.id})`)
  await rest(`candidates?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_status: 'fetching' }) })
  try {
    if (await hasSiblings(c)) throw new Error('複数人メール由来のためBox再解析不可（データ混線防止）')
    const f = await downloadBoxFile(c.box_url)
    log(`  [box:${c.name}] DL完了 ${f.name} (${f.buf.length}B)`)
    // 過去の合成本文・合成件名（旧実装の残骸）は元本文扱いしない
    const origBody = c.body && !c.body.startsWith('Box経歴書ファイル取込') ? c.body : null
    const origSubject = c.subject && !c.subject.startsWith('【Box経歴書】') ? c.subject : null
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/inbound-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        subject: origSubject ?? `Box経歴書取込 ${c.name ?? ''}`,
        body: origBody ?? '',
        from: c.mailfrom || `box+${c.id}@upload.invalid`,
        attachments: [{ data: f.buf.toString('base64'), mimeType: f.mimeType, name: f.name }],
        mode: c.data_env, type: 'candidate', force: true, target_candidate_id: c.id,
      }),
    })
    if (!resp.ok) throw new Error(`inbound-email ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    // regex再解析後の最新状態で LLM 再解析（resume_url が付いている）
    const [fresh] = await rest(`candidates?select=${CAND_SELECT}&id=eq.${c.id}`)
    if (fresh) {
      // 元本文が無い場合、空本文の再解析で本文由来フィールドが消えるため元の値を復元する
      if (!origBody) {
        const restore = {}
        if (c.from_company && fresh.from_company !== c.from_company) restore.from_company = c.from_company
        if (c.desired_rate && !fresh.desired_rate) restore.desired_rate = c.desired_rate
        if (Object.keys(restore).length) {
          await rest(`candidates?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(restore) })
          Object.assign(fresh, restore)
          log(`  [box:${c.name}] 本文由来フィールド復元: ${Object.keys(restore).join(', ')}`)
        }
      }
      await processCandidate(fresh)
      state.dayCount++
      saveState()
    }
    await rest(`candidates?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_status: 'enriched' }) })
    log(`  [box:${c.name}] 完了`)
  } catch (e) {
    log(`  [box:${c.name}] 失敗:`, String(e).slice(0, 200))
    await rest(`candidates?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_status: 'failed' }) }).catch(() => {})
  }
}

async function boxQueue() {
  if (state.dayCount >= MAX_PER_DAY) return
  // ① 手動依頼（UIボタン）を最優先
  const manual = await rest(
    `candidates?select=${BOX_SELECT}&box_status=eq.fetch_requested&order=created_at.asc&limit=3`) ?? []
  // ② 全自動取込: 経歴書未取得（resume_url なし）の pending prod 人材。
  //    created_at < watermark で「本サイクル通過済み」を保証（本文LLM処理との競合回避）
  const auto = manual.length >= 3 ? [] : (await rest(
    `candidates?select=${BOX_SELECT}&box_status=eq.pending&resume_url=is.null&box_url=not.is.null` +
    `&data_env=eq.prod&created_at=lt.${encodeURIComponent(state.watermark)}` +
    `&order=created_at.desc&limit=${AUTO_BOX_PER_POLL}`)) ?? []
  for (const c of [...manual, ...auto]) {
    if (state.dayCount >= MAX_PER_DAY) return
    await processBoxCandidate(c)
  }
}

log(`ワーカー起動 mode=${APPLY ? '本番上書き' : 'シャドー記録のみ'} watermark=${state.watermark} 上限=${MAX_PER_CYCLE}/cycle, ${MAX_PER_DAY}/day`)
// 前回クラッシュで 'fetching' のまま残った依頼を復帰させる
await rest(`candidates?box_status=eq.fetching`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_status: 'fetch_requested' }) }).catch(() => {})
while (true) {
  try { await cycle() } catch (e) { log('cycle error:', String(e).slice(0, 300)) }
  for (let i = 0; i < CYCLE_MS / BOX_POLL_MS; i++) {
    try { await boxQueue() } catch (e) { log('box queue error:', String(e).slice(0, 200)) }
    await new Promise(r => setTimeout(r, BOX_POLL_MS))
  }
}
