// llm_extract/apply.mjs — LLM抽出結果を candidates に反映する（本番上書き）
//
// 方針（2026-08-07 ユーザー判断「新規人材からAIで全上書き」）:
//  - 上書きするのは「AIが値を出せたフィールドのみ」。AIがnull/空なら regex の値を残す
//    （全項目を無条件にnullで潰すと、regexが正しく取れていた項目まで壊れるため）
//  - 上書き前の regex 値は raw_profile._regex_backup に退避（答え合わせ・巻き戻し用）
//  - skills 列だけは「追加のみ」。理由は下記 SKILLS_REPLACE 参照
//  - 変更が無ければ PATCH を投げない（Supabase書き込み回数の削減）
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { normTech } from './lib.mjs'

/** 駅名→都道府県（inbound-email と同じスナップショットを共有する） */
const STATION_MAP = JSON.parse(readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    'supabase/functions/inbound-email/station_data.json'), 'utf8'))

/**
 * 最寄駅の記載から都道府県を引く（路線名・注記・徒歩分数を除いて照合）。
 * 同名駅で複数県にまたがる場合は首都圏が1つだけならそれを採用、割れるなら null
 * （inbound-email の lookupStationPrefectureFromDb と同じ方針）。
 */
export function prefectureFromStation(station) {
  const base = String(station ?? '').replace(/[※（(].*$/s, '')
    .replace(/徒歩\s*\d+\s*分|バス\s*\d+\s*分/g, '').trim()
  if (!base) return null
  const keys = []
  const push = (x) => {
    const k = x.replace(/駅$/, '').replace(/\s+/g, '').replace(/ヶ/g, 'ケ').trim()
    if (k && !keys.includes(k)) keys.push(k)
  }
  push(base)
  for (const tok of base.split(/[\s　、,/／]+/)) {
    if (!tok || /線$|鉄道$|電鉄$|^JR|^ＪＲ/.test(tok)) continue
    push(tok)
  }
  const KANTO = ['東京都', '神奈川県', '埼玉県', '千葉県']
  for (const k of keys) {
    const entries = STATION_MAP[k]
    if (!entries?.length) continue
    const prefs = [...new Set(entries.map((e) => e.prefecture))]
    if (prefs.length === 1) return prefs[0]
    const kanto = prefs.filter((p) => KANTO.includes(p))
    if (kanto.length === 1) return kanto[0]
    return null
  }
  return null
}

// skills 列を AI の techs で完全置換するか。
// false の理由: skills は skill_master 照合を通った正規化済みデータで、
// 「テスト/要件定義/保守運用」等の工程スキルは営業判断で意図的に含めている
// （CLAUDE.md Phase 4.x「残す方針に転換」）。AIプロンプトは工程名を除外する設計のため、
// 全置換すると営業が使っているスキルが消えてマッチングが劣化する。
// AI が見つけた技術のうち skill_master に存在して未登録のものだけ追加する。
export const SKILLS_REPLACE = false

/**
 * フィールドごとの上書き方針。2026-08-07 に実データ60件でドライランして決定。
 *   'overwrite' … regex に値があっても AI で置き換える（AIが明確に優れていた項目）
 *   'fill'      … regex が空のときだけ AI を入れる（AIが劣化させる実例が出た項目）
 * 根拠（ドライラン実例）:
 *   name         regex「年　数」「項番」「Frame」→ AI「TO」「KS」「M.Y」   … AI圧勝
 *   from_company regex「Visual StudioCo」→ AI「株式会社ai・more」          … AI圧勝
 *   desired_rate regex「61～65万円」→ AI「65万円」                         … 範囲の下限が消える
 *   nearestStation regex「西新宿五丁目駅」→ AI「月～都営大江戸線　西新宿五丁目駅」… ゴミ混入
 *                  かつ駅名→都道府県の逆引きに影響するため触らない
 *   availableFrom 「9月」→「9月～」等、意味が変わらない書き換えのみ
 *   employmentType AI「1社先個人事業主」は商流と雇用形態の混在。UI は両者を別扱いしており
 *                  (raw_profile.commercialFlow が「N社先」を保持)、さらに
 *                  MatchingPage が employmentType === '派遣社員' の完全一致で
 *                  派遣許可チェックを分岐させるため、書き換えると当該処理が無効化される
 */
export const FIELD_POLICY = {
  name: 'overwrite',
  from_company: 'overwrite',
  age: 'overwrite',
  gender: 'overwrite',
  experience_years: 'overwrite',
  skillYears: 'overwrite',
  projects: 'overwrite',
  desired_rate: 'fill',
  nearestStation: 'fill',
  availableFrom: 'fill',
  employmentType: 'fill',
}

const norm = s => String(s ?? '').replace(/[\s　・.,]/g, '').toLowerCase()

/** AI の氏名が使えるか。数字混入（年齢・駅名の巻き込み）を弾く: 例「KM」→「KM29蕨」 */
export function isUsableName(n) {
  const s = String(n ?? '').trim()
  return !!s && s.length <= 20 && !/\d/.test(s)
}

/** 性別は「男」「男性」等の表記ゆれがあるため意味で比較する（無意味な書き込みを防ぐ） */
export const genderMeaning = g => {
  const s = String(g ?? '')
  if (/^男/.test(s)) return 'M'
  if (/^女/.test(s)) return 'F'
  return null
}

/** 期間の暦union（月数）。lib.mjs と同じ考え方だが総経験年数用に全案件をまとめる */
export function unionMonths(intervals) {
  if (!intervals.length) return 0
  const s = intervals.slice().sort((a, b) => a[0] - b[0])
  let tot = 0, cs = s[0][0], ce = s[0][1]
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i]
    if (a <= ce + 1) ce = Math.max(ce, b)
    else { tot += ce - cs + 1; cs = a; ce = b }
  }
  return tot + ce - cs + 1
}

const NOW_YM = (() => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() + 1 })()
const parseYM = s => {
  if (!s) return null
  if (/present|現在/i.test(String(s))) return NOW_YM
  const m = String(s).match(/(\d{4})[\/年.\-](\d{1,2})/)
  return m ? (+m[1]) * 12 + (+m[2]) : null
}

/** 案件の暦unionから総経験年数を算出。長年の課題だった「案件表の期間合計」をここで担う */
export function experienceYearsFromProjects(projects) {
  const iv = []
  for (const p of projects || []) {
    const s = parseYM(p.start), e0 = parseYM(p.end)
    if (s == null || e0 == null) continue
    iv.push([s, Math.max(s, e0)])
  }
  if (!iv.length) return null
  const y = Math.round(unionMonths(iv) / 12)
  // 実在しない値は採用しない（0年・60年超はグリッド誤読の疑い）
  return y >= 1 && y <= 60 ? y : null
}

/**
 * 複数人メールの場合 body_fields は全員分の配列になる。
 * この候補者レコードに対応する1件だけを名前で特定する。
 * 特定できなければ null（他人の年齢・単価を書き込む事故を防ぐ）
 */
export function pickBodyFieldsFor(candidateName, aiCandidates) {
  const list = (aiCandidates || []).filter(x => x && typeof x === 'object')
  if (!list.length) return null
  if (list.length === 1) return list[0]
  const target = norm(candidateName)
  if (!target) return null
  const exact = list.filter(x => norm(x.name) === target)
  if (exact.length === 1) return exact[0]
  const partial = list.filter(x => {
    const n = norm(x.name)
    return n && (n.includes(target) || target.includes(n))
  })
  return partial.length === 1 ? partial[0] : null
}

const isEmpty = v => v == null || (typeof v === 'string' && !v.trim())

/**
 * 上書きパッチを組み立てる。
 * 返り値 { patch, changes } — changes が空なら DB を触らない
 */
export function buildPatch(cand, { bodyFields, attachment }) {
  const rp = { ...(cand.raw_profile || {}) }
  const changes = []
  const backup = { ...(rp._regex_backup || {}) }
  const top = {}

  // 退避は初回のみ（2回目以降の上書きで regex 値を失わないため）
  const stash = (key, val) => { if (!(key in backup)) backup[key] = val ?? null }

  // eq: 意味が同じなら書き込まない比較関数（既定は文字列一致）
  const set = (key, val, { raw, eq } = {}) => {
    const cur = raw ? rp[key] : cand[key]
    if (isEmpty(val)) return
    // 既定は fill（安全側）。'overwrite' に明記した項目だけが既存値を置き換える
    if (FIELD_POLICY[key] !== 'overwrite' && !isEmpty(cur)) return
    const same = eq ? eq(cur, val) : String(cur ?? '') === String(val)
    if (same) return
    stash(key, cur)
    if (raw) rp[key] = val; else top[key] = val
    changes.push(key)
  }

  if (bodyFields) {
    if (isUsableName(bodyFields.name)) set('name', bodyFields.name)
    set('desired_rate', bodyFields.rate)
    set('from_company', bodyFields.company)
    set('age', typeof bodyFields.age === 'number' ? bodyFields.age : null, { raw: true })
    set('gender', bodyFields.gender, { raw: true, eq: (a, b) => genderMeaning(a) === genderMeaning(b) })
    set('nearestStation', bodyFields.station, { raw: true })
    // 駅を補完したら都道府県も引き直す。regex 側は駅が空の状態で本文から都道府県を
    // 推定しており（送信元住所を拾いがち）、駅だけ後から入ると矛盾が残るため
    // （実害: HH「練馬駅」なのに神奈川県。監査で15件検出・2026-08-10）
    if (changes.includes('nearestStation')) {
      const p = prefectureFromStation(rp.nearestStation)
      if (p && p !== rp.prefecture) {
        stash('prefecture', rp.prefecture ?? null)
        rp.prefecture = p
        changes.push('prefecture')
      }
    }
    set('availableFrom', bodyFields.availability, { raw: true })
    set('employmentType', bodyFields.employment, { raw: true })
  }

  if (attachment) {
    const projects = attachment.projects || []
    const sy = attachment.skill_years || attachment.skillYears || {}
    if (projects.length) {
      stash('projects', rp.projects ?? null)
      rp.projects = projects; changes.push('projects')
      const ey = experienceYearsFromProjects(projects)
      if (ey != null && ey !== cand.experience_years) {
        stash('experience_years', cand.experience_years)
        top.experience_years = ey; changes.push('experience_years')
      }
    }
    if (Object.keys(sy).length) {
      stash('skillYears', rp.skillYears ?? null)
      rp.skillYears = sy; changes.push('skillYears')
    }
  }

  if (!changes.length) return { patch: null, changes }

  rp._regex_backup = backup
  rp._llm_applied = {
    at: new Date().toISOString(),
    model: attachment?.model ?? bodyFields?._model ?? null,
    status: attachment?.status ?? null,
    fields: changes,
  }
  return { patch: { ...top, raw_profile: rp, updated_by: 'llm-overwrite' }, changes }
}

/** skill_master に存在し、かつ未登録の AI 技術名を skills に追加する */
export function mergeSkills(existing, aiTechs, skillMasterNormSet) {
  const cur = Array.isArray(existing) ? existing : []
  const have = new Set(cur.map(normTech))
  const add = []
  for (const t of aiTechs) {
    const k = normTech(t)
    if (!k || k.length < 2 || have.has(k) || !skillMasterNormSet.has(k)) continue
    have.add(k); add.push(String(t).trim())
  }
  return add.length ? cur.concat(add) : null
}

export const techsFromProjects = projects =>
  [...new Set((projects || []).flatMap(p => p.techs || []).map(t => String(t).trim()).filter(Boolean))]
