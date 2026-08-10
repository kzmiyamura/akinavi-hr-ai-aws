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
import { extractProjects, extractBodyFields, extractProjectFields } from './run.mjs'
import { buildPatch, pickBodyFieldsFor, mergeSkills, techsFromProjects, SKILLS_REPLACE, isUsableName } from './apply.mjs'
import { buildProjectPatch } from './project_apply.mjs'
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

/** AI校正の進行状態を raw_profile._llm_stage に記録する（UI表示用）。
 *  段階（2026-08-10 ユーザー指定）:
 *    印なし  … ルールベースのみ           → UI「AI校正待ち」
 *    'body'  … 本文をHaikuで解析済        → UI「AI校正開始」
 *    'sonnet'… 添付Haikuが不合格でSonnet中 → UI「AI校正中」
 *    _llm_checked_at あり … 完了           → UI 表示なし
 *  raw_profile は丸ごと送り返す必要がある（PostgREST の PATCH は列単位の置換のため）。
 *  進行表示のための書き込みなので、経歴書の解析が続く場合だけ呼ぶ（無駄書きを避ける） */
async function markStage(c, stage) {
  const rp = { ...(c.raw_profile || {}), _llm_stage: stage }
  await rest(`candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
  })
  c.raw_profile = rp   // 後続の PATCH が古い raw_profile で上書きしないよう手元も更新
}

/** 「AI校正が済んだ」印を残す。変更が無かった人・解析対象が無かった人にも必ず付ける。 */
async function markLlmChecked(c) {
  const rp = { ...(c.raw_profile || {}), _llm_checked_at: new Date().toISOString(), _llm_stage: 'done' }
  await rest(`candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
  })
}

/** LLM の抽出結果を本番 candidates に反映する */
async function applyToCandidate(c, { bodyFields, attachment }) {
  const { patch, changes } = buildPatch(c, { bodyFields, attachment })
  if (!patch) {
    await markLlmChecked(c)
    log(`  [${c.name}] 変更なし（校正済みの印のみ記録）`)
    return
  }
  patch.raw_profile._llm_checked_at = new Date().toISOString()
  patch.raw_profile._llm_stage = 'done'

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

/** 非人材（案件メール等の誤登録）を一覧から隔離し、GitHub Issue で通知する。
 *  merged_into を自己参照にすると全一覧クエリ（merged_into IS NULL 前提）から消える。
 *  復活: node scripts/restore_candidate.mjs <id>（2026-08-10 ユーザー判断「隔離＋通知」） */
// 同じメールから複数の幽霊が出ると Issue が乱立するため、メール単位で最初の1件だけ通知する
// （実害: 1通のメールから4件のIssueが飛んだ・2026-08-10）。再起動でリセットされるが、
// 通知は「気づくため」のものなので取りこぼしより重複抑制を優先する
const notifiedSources = new Set()

async function quarantineCandidate(c, reason, detail) {
  const rp = { ...(c.raw_profile || {}), _quarantine: { reason, detail, at: new Date().toISOString() } }
  await rest(`candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ merged_into: c.id, raw_profile: rp }),
  })
  const srcKey = `${c.raw_profile?.from ?? ''}|${c.raw_profile?.subject ?? ''}`
  if (notifiedSources.has(srcKey)) {
    log(`  [${c.name}] ${detail} → 隔離（同一メールの通知は送信済みのため省略）`)
    return
  }
  notifiedSources.add(srcKey)
  log(`  [${c.name}] ${detail} → 隔離・Issue通知`)
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/create-github-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        memo: `非人材検知: 「${c.name}」（${c.from_company ?? '会社不明'}）を一覧から隔離しました\n\n` +
          `判定: ${detail}\nid: ${c.id}\n` +
          `元メール: ${c.raw_profile?.subject ?? '(件名不明)'}\n\n` +
          `※ 同じメールから他にも隔離された人材がいる場合、通知はこの1件にまとめています。\n` +
          `　 一覧確認: node scripts/audit_quarantined.mjs\n\n` +
          `- 削除する場合: node scripts/delete_candidate.mjs ${c.id}\n` +
          `- 誤検知で復活する場合: node scripts/restore_candidate.mjs ${c.id}`,
        nickname: 'shadow-worker',
      }),
    })
  } catch (e) { log(`  [${c.name}] Issue通知失敗:`, String(e).slice(0, 100)) }
}

/** 幽霊レコード検知（ルールベースの名簿誤検出で生まれた実在しない人材）。
 *  条件: 本文にはっきり人が書かれている / この人はその誰でもない / 人の属性が何も無い、の3点同時。
 *  名簿だけのメール（本文に人名なし）由来の正規の人材は bodyNames が空になるため対象外。
 *  regex が「存在しない人」を作るミスは項目の上書きでは直せないため、隔離で対処する。 */
function isPhantomRecord(c, bfCandidates) {
  const normName = (s) => String(s ?? '').replace(/[\s　・.,【】()（）]/g, '').toLowerCase()
  const bodyNames = (bfCandidates ?? []).filter((x) => isUsableName(x?.name)).map((x) => normName(x.name))
  if (bodyNames.length === 0) return false            // 名簿のみのメール → 判定しない（安全側）
  const mine = normName(c.name)
  if (!mine) return false
  const matchesBody = bodyNames.some((n) => n && (n === mine || n.includes(mine) || mine.includes(n)))
  if (matchesBody) return false                        // 本文の誰かと一致 → 実在
  const hasPersonAttr = !!(c.desired_rate || c.raw_profile?.age != null || c.raw_profile?.gender)
  return !hasPersonAttr                                // 人の属性が1つも無ければ幽霊
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
      // 非人材検知: LLMが「人材メールではない」と判定し、かつ使える氏名が1人も無い場合のみ隔離
      // （二重条件で誤隔離を防ぐ。実害例: 案件メールが「不明」人材として登録された 2026-08-10）
      const noUsablePerson = !(bf.candidates ?? []).some(x => isUsableName(x?.name))
      if (APPLY && bf.mailType && bf.mailType !== 'candidate' && noUsablePerson) {
        await quarantineCandidate(c, `mailType=${bf.mailType}`, `案件メール等の誤登録（AI判定: ${bf.mailType}）`)
        return
      }
      // 幽霊レコード検知（名簿誤検出で生まれた実在しない人材）
      if (APPLY && isPhantomRecord(c, bf.candidates)) {
        await quarantineCandidate(c, 'phantom', '本文の誰とも一致せず人の属性も無い（名簿誤検出の幽霊）')
        return
      }
      // 複数人メールでは自分の行だけを選ぶ。特定できなければ本文由来は上書きしない
      bodyFields = pickBodyFieldsFor(c.name, bf.candidates)
      if (bodyFields) bodyFields._model = bf.model  // _llm_applied.model 記録用（buildPatch が参照）
      if (!bodyFields && (bf.candidates?.length ?? 0) > 1) {
        log(`  [${c.name}] 本文に複数人・特定不可のため本文フィールドは上書きせず`)
      }
      // 経歴書の解析がこの後も続く場合だけ「本文解析済み」を記録する
      // （続かない場合は直後に完了印を書くので、無駄な書き込みを増やさない）
      if (APPLY && /\.(xlsx?|xlsm|docx|pdf)$/i.test(c.resume_url ?? '')) await markStage(c, 'body')
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
      const r = await extractProjects(grid, {
        log: m => log(`  [${c.name}]`, m),
        kind,
        // Haiku が不合格で Sonnet に引き継ぐ瞬間に UI を「AI校正中」へ切り替える
        onEscalate: APPLY ? () => markStage(c, 'sonnet') : null,
      })
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

  if (APPLY) {
    try {
      // 解析対象が無かった人（本文が短くリンクも添付も無い）にも校正済みの印は残す
      if (bodyFields || attachment) await applyToCandidate(c, { bodyFields, attachment })
      else { await markLlmChecked(c); log(`  [${c.name}] 解析対象なし（校正済みの印のみ記録）`) }
    } catch (e) { log(`  [${c.name}] 上書き失敗:`, String(e).slice(0, 200)) }
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

// ── 案件のLLM補正サイクル ──
// UI「新規登録」や（将来有効化する）メール由来で作られた新規案件を後追いで補正し、
// 人材と同じ品質にする（2026-08-08 ユーザー依頼「入力画面からの取り込みも人材レベルに」）。
// 方針は project_apply.mjs（既定 fill・required_skills は skill_master 照合の追加のみ）。
// 複数案件が1本文にまとまっている行（batchSize>1）は対応付けを誤ると壊すためスキップ。
const PROJ_MAX_PER_CYCLE = 10
const PROJ_SELECT = 'id,title,client,required_skills,budget_min,budget_max,start_date,work_location,' +
  'remote_policy,contract_type,headcount,workload,settlement_min,settlement_max,role_summary,industry,raw_data,created_at'

async function projectCycle() {
  if (state.dayCount >= MAX_PER_DAY) return
  if (!state.projWatermark) { state.projWatermark = new Date().toISOString(); saveState() }
  const rows = await rest(
    `projects?select=${PROJ_SELECT}&data_env=eq.prod&created_at=gt.${encodeURIComponent(state.projWatermark)}` +
    `&order=created_at.asc&limit=${PROJ_MAX_PER_CYCLE}`)
  if (!rows?.length) return
  log(`新規案件 ${rows.length}件`)
  for (const p of rows) {
    try {
      const text = String(p.raw_data?.text ?? '')
      const batchSize = p.raw_data?.batchSize ?? 1
      if (text.length < 50) log(`案件[${p.title}] 本文なし・スキップ`)
      else if (batchSize > 1) log(`案件[${p.title}] 複数案件メール由来(${batchSize}件)・対応付け不能のためスキップ`)
      else {
        const r = await extractProjectFields(text.slice(0, 8000))
        state.dayCost += r.costUsd || 0
        if ((r.projects?.length ?? 0) !== 1) {
          log(`案件[${p.title}] LLM検出${r.projects?.length ?? 0}件（1件でないためスキップ）`)
        } else if (APPLY) {
          const { patch, changes } = buildProjectPatch(p, { ...r.projects[0], _model: r.model }, await skillMasterSet())
          if (patch) {
            await rest(`projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
            log(`案件[${p.title}] 上書き: ${changes.join(', ')}`)
          } else log(`案件[${p.title}] 変更なし`)
        }
      }
    } catch (e) {
      log(`案件[${p.title}] 失敗:`, String(e).slice(0, 200))
    }
    state.projWatermark = p.created_at
    state.dayCount++
    saveState()
  }
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
    // inbound-email が本文の Box URL を再抽出して box_status を 'pending' に戻すため、
    // LLM解析中に UI の「AI取込」ボタンが復活して二重依頼できてしまう → 'fetching' に戻す
    await rest(`candidates?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_status: 'fetching' }) })
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
  try { await projectCycle() } catch (e) { log('project cycle error:', String(e).slice(0, 300)) }
  for (let i = 0; i < CYCLE_MS / BOX_POLL_MS; i++) {
    try { await boxQueue() } catch (e) { log('box queue error:', String(e).slice(0, 200)) }
    await new Promise(r => setTimeout(r, BOX_POLL_MS))
  }
}
