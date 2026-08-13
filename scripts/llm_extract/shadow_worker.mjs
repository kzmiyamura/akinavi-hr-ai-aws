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
import { extractProjects, extractBodyFields, extractBodyFieldsBatch, extractProjectFields, extractProjectInterpretation, extractRecommendation } from './run.mjs'
import { projectText, candidateText, buildRecommendationRecord } from './recommend_lib.mjs'
import { buildPatch, pickBodyFieldsFor, mergeSkills, techsFromProjects, SKILLS_REPLACE, isUsableName } from './apply.mjs'
import { buildProjectPatch, buildInterpretationPatch, DEFAULT_TITLE } from './project_apply.mjs'
import { downloadBoxFile } from './box_fetch.mjs'
import {
  trimBodyForLlm, projectLooksComplete, parseSkillFilterValue, buildSkillFilterClause, pacedAllowance,
  shouldSkipBodyLlm,
} from './shadow_worker_lib.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!SUPABASE_URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY を設定してください'); process.exit(1) }

const STATE_FILE = path.join(os.homedir(), '.akinavi_shadow_state.json')
const CYCLE_MS = 5 * 60 * 1000
const MAX_PER_CYCLE = 15        // 1サイクルのLLM対象候補者上限
// 本文抽出をまとめて処理する人数。大きいほど固定費は下がるが、
// 1回のプロンプトが長くなり取り違え・出力切れのリスクが増えるため中庸にする
const BODY_BATCH_SIZE = Number(process.env.SHADOW_BODY_BATCH ?? 5)
// 日次上限（サブスク枠保護）。到着は約750件/日で処理能力を大きく上回るため、
// この上限が実質的な支出コントロールになる。2026-08-10 に 400→100。
// 根拠: 同日 regex 側の skillYears を修正（回帰 2Pass→8Pass）して素の品質が上がり、
// AI補正の限界効用が下がった。新しい順に処理するので少数でも価値は落ちにくい
const MAX_PER_DAY = Number(process.env.SHADOW_MAX_PER_DAY ?? 100)
// 何日前までを処理対象にするか。7日で archive-candidates がアーカイブへ移すため、
// それより手前で切る。古いものを掘り返して予算を使い切らないための足切り
const LOOKBACK_DAYS = Number(process.env.SHADOW_LOOKBACK_DAYS ?? 3)
// 失敗を繰り返すレコードの打ち切り回数。キュー方式は「未処理のもの」を拾い続けるため、
// 失敗を記録しないと同じレコードを永久に再処理して費用が出続ける
const MAX_ATTEMPTS = 3
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
 *  段階（2026-08-10 ユーザー指定 → 同日 Haiku 単独運用に伴い 'sonnet' を廃止）:
 *    印なし  … ルールベースのみ           → UI「AI校正待ち」
 *    'body'  … 本文をHaikuで解析済        → UI「AI校正開始」
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

/** 処理に失敗した回数を raw_profile._llm_attempts に積む。
 *  キュー方式は「_llm_checked_at が無いもの」を拾い続けるため、失敗を記録しないと
 *  同じレコードを永久に再処理して費用が出続ける。MAX_ATTEMPTS で打ち切る。 */
async function markAttempt(c, err) {
  const n = (c.raw_profile?._llm_attempts ?? 0) + 1
  const rp = { ...(c.raw_profile || {}), _llm_attempts: n, _llm_last_error: String(err).slice(0, 200) }
  log(`  [${c.name}] 失敗(${n}/${MAX_ATTEMPTS}):`, String(err).slice(0, 160))
  await rest(`candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
  }).catch(() => {})
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
// 隔離の通知は1件ごとに出すと Issue が乱立する（実害: 3時間で20件・2026-08-10）。
// 溜めておき、1時間に1回だけ「まとめ」を1本投げる。データ自体は隔離済みで
// audit_quarantined.mjs からいつでも全件確認できるため、通知は気づきのきっかけで足りる。
const QUARANTINE_NOTIFY_INTERVAL_MS = 60 * 60 * 1000
const pendingQuarantines = []
let lastQuarantineNotifyAt = 0

async function quarantineCandidate(c, reason, detail) {
  const rp = { ...(c.raw_profile || {}), _quarantine: { reason, detail, at: new Date().toISOString() } }
  await rest(`candidates?id=eq.${c.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ merged_into: c.id, raw_profile: rp }),
  })
  log(`  [${c.name}] ${detail} → 隔離`)
  pendingQuarantines.push({
    name: c.name, company: c.from_company ?? '会社不明', id: c.id, detail,
    subject: c.raw_profile?.subject ?? '(件名不明)',
  })
}

/** 溜まった隔離をまとめて1本のIssueで通知する（サイクル末に呼ぶ） */
async function flushQuarantineNotice() {
  if (!pendingQuarantines.length) return
  if (Date.now() - lastQuarantineNotifyAt < QUARANTINE_NOTIFY_INTERVAL_MS) return
  const items = pendingQuarantines.splice(0)
  lastQuarantineNotifyAt = Date.now()
  // 元メール（件名）ごとにまとめる。1通の名簿誤検出から何人も出るため
  const byMail = new Map()
  for (const q of items) {
    const k = `${q.company}｜${q.subject.slice(0, 50)}`
    if (!byMail.has(k)) byMail.set(k, [])
    byMail.get(k).push(q)
  }
  const body = [...byMail.entries()]
    .map(([k, list]) => `■ ${k}（${list.length}件）\n　 ${list.map((q) => q.name).join(', ')}\n　 判定: ${list[0].detail}`)
    .join('\n\n')
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/create-github-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        memo: `非人材検知まとめ: ${items.length}件を一覧から隔離しました（元メール${byMail.size}通）\n\n${body}\n\n` +
          `全件確認: node scripts/audit_quarantined.mjs\n` +
          `一括削除: node scripts/audit_quarantined.mjs 7 --delete\n` +
          `誤検知の復活: node scripts/restore_candidate.mjs <id>`,
        nickname: 'shadow-worker',
      }),
    })
    log(`隔離まとめ通知: ${items.length}件（元メール${byMail.size}通）`)
  } catch (e) { log('隔離まとめ通知に失敗:', String(e).slice(0, 100)) }
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

/** regex が主要項目を埋めきっていれば本文LLMを省く（コスト削減）。
 *  幽霊・非人材は属性が揃わないため、この条件を満たさず必ずAIの検査を通る */
function bodyLooksComplete(c) {
  const rp = c.raw_profile ?? {}
  return !!(isUsableName(c.name) && c.desired_rate && c.from_company &&
    (rp.age != null || rp.gender) && rp.nearestStation)
}

async function processCandidate(c, preBody = null) {
  let bodyFields = null, attachment = null

  // 本文フィールド（常にHaiku）
  const bodyText = c.raw_profile?.text ?? ''
  if (bodyText.length > 50 && !preBody && shouldSkipBodyLlm(c.resume_url, bodyLooksComplete(c))) {
    log(`  [${c.name}] 本文の主要項目は充足済み → 本文LLMを省略`)
  } else if (bodyText.length > 50) {
    try {
      const t0 = Date.now()
      const bf = preBody ?? await extractBodyFields(trimBodyForLlm(bodyText))
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
      // Haiku 単独運用のため昇格通知は無い（2026-08-10）。UI の段階も body → done の2つだけ
      const r = await extractProjects(grid, { log: m => log(`  [${c.name}]`, m), kind })
      await saveShadow({
        candidate_id: c.id, source: 'attachment', model: r.model, status: r.status,
        reasons: r.reasons, quality: r.quality, projects: r.projects, skill_years: r.skillYears,
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

/**
 * AI校正の対象を絞る条件を組み立てる（app_config.llm_filter_skills）。
 * 未設定・空配列なら絞り込みなし＝全件が対象（既定・後方互換）。
 *
 * 一致判定は2本立て:
 *   ① skills 列 … regex抽出済みで skill_master 照合を通っているため表記ゆれに強い
 *   ② メール本文 … skills が空（regexが取れなかった）人材を落とさないための保険
 *
 * ②は部分一致なので "Java" は "JavaScript" にも当たる。絞りが甘くなるが、
 * 該当者を落とすと営業機会を失うため多めに拾う側に倒している。
 * サーバー側で絞るので Supabase の転送量も同時に減る。
 */
async function skillFilterClause() {
  let list = null
  try {
    const rows = await rest('app_config?select=value&key=eq.llm_filter_skills')
    list = parseSkillFilterValue(rows?.[0]?.value)
  } catch { /* 設定が読めないときは絞らない（安全側） */ }
  return { clause: buildSkillFilterClause(list), list }
}

async function cycle() {
  const today = new Date().toISOString().slice(0, 10)
  if (state.day !== today) { state.day = today; state.dayCount = 0; state.dayCost = 0 }
  if (state.dayCount >= MAX_PER_DAY) { log(`日次上限${MAX_PER_DAY}到達、スキップ`); return }
  // 上限を24時間に均す。均さないと能力いっぱいで走って朝の数時間で使い切り、
  // 営業時間中に届いた人材が当日処理されない（新しい順にした意味が消える）
  const allowed = pacedAllowance(MAX_PER_DAY)
  if (state.dayCount >= allowed) {
    log(`ペース配分により待機（この時刻の上限${allowed}件・処理済${state.dayCount}件）`)
    return
  }

  // buildPatch / mergeSkills が参照するトップレベル列は必ず select に含めること。
  // 欠けると「既存値なし」と誤認して fill 項目まで上書き・skills 全置換になる（2026-08-08 に実害）
  // キュー方式（2026-08-10 に watermark から変更）。
  // 旧方式は created_at 昇順に前進するカーソルで、到着(約750件/日)が処理能力を
  // 上回るため遅れが伸び続け、予算を「3〜5日前の、まもなくアーカイブされる人材」に
  // 使っていた（実測: 未処理839件・最古5日前）。
  //   ・新しい順に処理する      … 同じ支出で価値の高い人材から埋まる
  //   ・LOOKBACK_DAYS で足切り  … 古い在庫を掘り返して予算を溶かさない
  //   ・「印が無いもの」を拾う    … カーソルが詰まらず取りこぼしも自然に回収される
  // 再解析(inbound-email)は raw_profile を差し替えるため印も消え、自然に再入する
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()
  // buildPatch / mergeSkills が参照するトップレベル列は必ず select に含めること。
  // 欠けると「既存値なし」と誤認して fill 項目まで上書き・skills 全置換になる（2026-08-08 に実害）
  // このサイクルで実際に処理できる件数まで絞って取得する。
  // 多く取ると本文の一括抽出（有料）をその人数分行った上で、ペース配分で途中中断し、
  // 使わなかった抽出結果を捨てて次サイクルで同じ人を再抽出する＝払い直しになる
  // （ペース配分を入れた際に作り込んでしまった。15件抽出して1件処理という状態・2026-08-11）
  const room = Math.max(0, Math.min(MAX_PER_DAY, allowed) - state.dayCount)
  const take = Math.min(MAX_PER_CYCLE, room)
  if (take <= 0) { log('ペース配分により待機（今サイクルの処理枠なし）'); return }
  const { clause: skillClause, list: skillList } = await skillFilterClause()
  const q = `candidates?select=id,name,resume_url,raw_profile,created_at,desired_rate,from_company,experience_years,skills` +
    `&data_env=eq.prod&merged_into=is.null` +
    `&raw_profile->>_llm_checked_at=is.null` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    skillClause +
    `&order=created_at.desc&limit=${take}`
  const rows = await rest(q)
  const filterNote = skillList ? `・スキル絞込[${skillList.join(',')}]` : ''
  if (!rows.length) { log(`未処理なし（直近${LOOKBACK_DAYS}日${filterNote}）`); return }
  log(`未処理 ${rows.length}件を処理（新しい順・直近${LOOKBACK_DAYS}日${filterNote}・今サイクル枠${take}件）`)

  // 失敗を繰り返すレコードは打ち切る。印が付かないまま残ると永久に再処理される
  const givenUp = (c) => (c.raw_profile?._llm_attempts ?? 0) >= MAX_ATTEMPTS
  // 本文抽出をまとめて1回で済ませる（claude -p の固定オーバーヘッドを人数で割る）。
  // 取り違えが起きたら件数不一致で検出し、その回は1件ずつに落とす
  const bodyOf = new Map()
  const need = rows.filter((c) => !givenUp(c) && (c.raw_profile?.text ?? '').length > 50 &&
    !shouldSkipBodyLlm(c.resume_url, bodyLooksComplete(c)))
  for (let i = 0; i < need.length; i += BODY_BATCH_SIZE) {
    const chunk = need.slice(i, i + BODY_BATCH_SIZE)
    if (chunk.length < 2) break                       // 1件ならまとめる意味がない
    try {
      const t0 = Date.now()
      const b = await extractBodyFieldsBatch(chunk.map((c) => trimBodyForLlm(c.raw_profile.text)))
      state.dayCost += b.costUsd || 0
      if (!b.results) { log(`本文一括: ${b.reason} のため個別処理にフォールバック`); continue }
      const per = (b.costUsd ?? 0) / chunk.length
      chunk.forEach((c, j) => bodyOf.set(c.id, { ...b.results[j], model: b.model, costUsd: per }))
      log(`本文一括: ${chunk.length}人を1回で抽出（${((Date.now() - t0) / 1000).toFixed(0)}秒・$${(b.costUsd ?? 0).toFixed(3)}）`)
    } catch (e) {
      log('本文一括に失敗、個別処理にフォールバック:', String(e).slice(0, 120))
    }
  }

  for (const c of rows) {
    if (state.dayCount >= MAX_PER_DAY) { log(`日次上限${MAX_PER_DAY}到達、以降は次回`); break }
    // サイクル内でもペース上限を超えたら止める（1サイクル15件で使い切らないため）
    if (state.dayCount >= pacedAllowance(MAX_PER_DAY)) { log('ペース配分により中断、以降は次回'); break }
    if (givenUp(c)) {
      log(`打ち切り（${MAX_ATTEMPTS}回失敗）: ${c.name}`)
      await markLlmChecked(c).catch(() => {})
      continue
    }
    log(`処理: ${c.name} (${c.id})`)
    try {
      await processCandidate(c, bodyOf.get(c.id) ?? null)
    } catch (e) {
      // キュー方式では失敗を記録しないと同じレコードを拾い続けて費用が出続ける
      await markAttempt(c, e)
    }
    state.dayCount++
    saveState()
  }
  await flushQuarantineNotice()
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
      else if (projectLooksComplete(p, DEFAULT_TITLE)) log(`案件[${p.title}] 主要項目は充足済み → LLMを省略`)
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

// ── 案件条件のAI解釈サイクル（2026-08-13 ユーザー合意） ──
// 案件登録時に1回だけLLMに条件を「解釈」させ、複数名前提フラグと関連スキル（尚可扱い）を立てる。
// 転記（projectCycle）と違い、書いていないことを読む役割。スコア計算はルールのまま。
// キュー方式: raw_data.aiInterpretation が無い open 案件を拾う。結果ゼロ・スキップでも
// 必ず印（aiInterpretation）を書くので同じ案件を二度は処理しない。
const INTERPRET_MAX_PER_CYCLE = 3

async function projectInterpretCycle() {
  if (state.dayCount >= MAX_PER_DAY) return
  const rows = await rest(
    `projects?select=${PROJ_SELECT}&data_env=eq.prod&status=eq.open` +
    `&raw_data->>aiInterpretation=is.null&order=created_at.desc&limit=${INTERPRET_MAX_PER_CYCLE}`)
  if (!rows?.length) return
  log(`AI解釈の未処理案件 ${rows.length}件`)
  for (const p of rows) {
    try {
      const text = String(p.raw_data?.text ?? '')
      const batchSize = p.raw_data?.batchSize ?? 1
      // 解釈できないものにも印を書く（書かないと永久に拾い続ける）
      const skip = text.length < 50 ? '本文なし'
        : batchSize > 1 ? `複数案件メール由来(${batchSize}件)・対応付け不能` : null
      if (skip) {
        const rd = { ...(p.raw_data || {}), aiInterpretation: { at: new Date().toISOString(), skipped: skip } }
        if (APPLY) await rest(`projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_data: rd }) })
        log(`案件解釈[${p.title}] スキップ: ${skip}`)
      } else {
        const r = await extractProjectInterpretation(text.slice(0, 8000))
        state.dayCost += r.costUsd || 0
        const { patch, changes } = buildInterpretationPatch(p, r, await skillMasterSet())
        if (APPLY) await rest(`projects?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) })
        log(`案件解釈[${p.title}] ${changes.length ? changes.join(', ') : '追加なし（印のみ記録）'}`)
        state.dayCount++
        saveState()
      }
    } catch (e) {
      // 失敗時は印を書かない＝次サイクルで再試行（案件は数が少なく暴走リスクが小さい）
      log(`案件解釈[${p.title}] 失敗:`, String(e).slice(0, 200))
    }
  }
}

// ── 提案所見サイクル（docs/matching_redesign.md 実装順①・2026-08-14） ──
// open prod 案件の上位N人の submissions に、案件本文×経歴を読み合わせた所見
// （推せる/条件付き/見送り・根拠付き）を書く。これが最終判断の本体で、
// ルール点数は候補出しの内部値という位置づけ。
// キュー方式: ai_raw.recommendation が無い上位ペアを拾う。出力不能でも印を書く。
// 再マッチングの upsert は ai_raw を丸ごと置き換えるので、顔ぶれ・スコアが変わると
// マーカーが消えて自動的に再生成対象へ戻る（明示的な無効化処理は不要）。
const REC_TOP_N = 10           // 案件ごとの対象順位
const REC_MAX_PER_CYCLE = 5    // 1サイクルの生成数（1件あたり約60〜90秒）

async function recommendCycle() {
  if (state.dayCount >= MAX_PER_DAY) return
  const projects = await rest(
    'projects?select=id,title,client,required_skills,raw_data,work_location,remote_policy,contract_type,budget_max' +
    '&data_env=eq.prod&status=eq.open&order=created_at.desc&limit=20')
  if (!projects?.length) return
  let made = 0
  for (const p of projects) {
    if (made >= REC_MAX_PER_CYCLE || state.dayCount >= MAX_PER_DAY) return
    // ai_raw 丸ごとは重いのでマーカーだけ取る（egress 節約）
    const subs = await rest(
      `submissions?select=id,candidate_id,match_score,rec_at:ai_raw->recommendation->>at` +
      `&project_id=eq.${p.id}&data_env=eq.prod&order=match_score.desc&limit=${REC_TOP_N}`)
    const todo = (subs ?? []).filter((s) => !s.rec_at)
    if (!todo.length) continue
    const pText = projectText(p)
    for (const sub of todo) {
      if (made >= REC_MAX_PER_CYCLE || state.dayCount >= MAX_PER_DAY) return
      try {
        const [c] = await rest(`candidates?select=id,name,skills,experience_years,desired_rate,from_company,raw_profile&id=eq.${sub.candidate_id}`) ?? []
        if (!c) continue
        const r = await extractRecommendation(pText, candidateText(c))
        state.dayCost += r.costUsd || 0
        // 読み直してからマージ（生成中に再マッチングで ai_raw が置き換わっている可能性がある。
        // その場合もこの書き込みは新しい ai_raw に所見を足すだけなので壊さない）
        const [cur] = await rest(`submissions?select=ai_raw&id=eq.${sub.id}`) ?? []
        const aiRaw = { ...(cur?.ai_raw ?? {}), recommendation: buildRecommendationRecord(r) }
        if (APPLY) await rest(`submissions?id=eq.${sub.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ai_raw: aiRaw }),
        })
        log(`所見[${p.title}] ${c.name}(${sub.match_score}点): ${r.verdict ?? '出力不能'} ${r.pitch ? r.pitch.slice(0, 60) : ''}`)
        made++
        state.dayCount++
        saveState()
      } catch (e) {
        // 失敗時は印を書かない＝次サイクルで再試行（上位Nに限られ暴走リスクは小さい）
        log(`所見[${p.title}] ${sub.candidate_id} 失敗:`, String(e).slice(0, 200))
      }
    }
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
  //    「本サイクル通過済み」を保証して本文LLM処理との競合を避ける。
  //    キュー方式に変えたため watermark ではなく校正済みの印そのもので判定する（2026-08-10）。
  //    古い在庫を掘り返さないよう本サイクルと同じ LOOKBACK_DAYS の足切りも入れる
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString()
  const auto = manual.length >= 3 ? [] : (await rest(
    `candidates?select=${BOX_SELECT}&box_status=eq.pending&resume_url=is.null&box_url=not.is.null` +
    `&data_env=eq.prod&raw_profile->>_llm_checked_at=not.is.null` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc&limit=${AUTO_BOX_PER_POLL}`)) ?? []
  for (const c of [...manual, ...auto]) {
    if (state.dayCount >= MAX_PER_DAY) return
    await processBoxCandidate(c)
  }
}

log(`ワーカー起動 mode=${APPLY ? '本番上書き' : 'シャドー記録のみ'} ` +
  `方式=キュー(新しい順・直近${LOOKBACK_DAYS}日) 上限=${MAX_PER_CYCLE}/cycle, ${MAX_PER_DAY}/day`)
// 前回クラッシュで 'fetching' のまま残った依頼を復帰させる
await rest(`candidates?box_status=eq.fetching`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ box_status: 'fetch_requested' }) }).catch(() => {})
// 停止・クラッシュで進行中のまま残った _llm_stage を掃除する。
// UI は時間で古さを推測しない方針（CandidatePage.tsx）なので、印が残ると
// 止まっているのに「AI校正中」等が出たままになる（2026-08-10 実害1件）。
// box_status と違い raw_profile は jsonb 列ごと置換になるため1件ずつ読み書きする。
// 廃止した 'sonnet' 段階の残骸もここで消える。同じ処理は clear_stale_stage.mjs でも単体実行できる
try {
  const stale = await rest('candidates?select=id,raw_profile&raw_profile->>_llm_stage=in.(body,sonnet)&limit=200')
  for (const c of stale ?? []) {
    const rp = { ...(c.raw_profile || {}) }
    delete rp._llm_stage
    await rest(`candidates?id=eq.${c.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ raw_profile: rp }),
    })
  }
  if (stale?.length) log(`停止中に残った進行印を掃除: ${stale.length}件`)
} catch (e) { log('進行印の掃除に失敗:', String(e).slice(0, 120)) }
while (true) {
  try { await cycle() } catch (e) { log('cycle error:', String(e).slice(0, 300)) }
  try { await projectCycle() } catch (e) { log('project cycle error:', String(e).slice(0, 300)) }
  try { await projectInterpretCycle() } catch (e) { log('project interpret error:', String(e).slice(0, 300)) }
  try { await recommendCycle() } catch (e) { log('recommend cycle error:', String(e).slice(0, 300)) }
  for (let i = 0; i < CYCLE_MS / BOX_POLL_MS; i++) {
    try { await boxQueue() } catch (e) { log('box queue error:', String(e).slice(0, 200)) }
    await new Promise(r => setTimeout(r, BOX_POLL_MS))
  }
}
