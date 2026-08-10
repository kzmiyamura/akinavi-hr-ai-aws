// llm_extract/project_apply.mjs — 案件のLLM抽出結果を projects に反映する
//
// 方針（2026-08-08・人材の apply.mjs と同思想）:
//  - 実測ドライランの蓄積が無い段階なので既定はすべて fill（既存値があれば触らない）
//  - required_skills は skill_master 照合済みの「追加のみ」（人材の skills と同じ理由）
//  - title だけは regex のフォールバック値「案件」なら置き換える（UI一覧の可読性に直結）
//  - 上書き前の値は raw_data._regex_backup、適用情報は raw_data._llm_applied
//  - 変更が無ければ PATCH しない
import { normTech } from './lib.mjs'
import { mergeSkills } from './apply.mjs'

/** フィールドごとの上書き方針。'fill'=空のときだけ / 'overwrite'=常に置換
 *  ドライランで regex 劣化の実証が取れた項目だけ overwrite に昇格させること */
export const PROJECT_FIELD_POLICY = {
  title: 'fill',            // ただし既存値が DEFAULT_TITLE のときは空扱い（下の isEmptyTitle）
  client: 'fill',
  budget_min: 'fill',
  budget_max: 'fill',
  start_date: 'fill',
  work_location: 'fill',
  remote_policy: 'fill',
  contract_type: 'fill',
  headcount: 'fill',
  workload: 'fill',
  settlement_min: 'fill',
  settlement_max: 'fill',
  role_summary: 'fill',
  industry: 'fill',
  // raw_data 内
  niceToHaveSkills: 'fill',
  requiredSkillYears: 'fill',
}

/** inbound-email が title を取れなかったときのフォールバック値
 *  （shadow_worker_lib の projectLooksComplete も「未入力」の判定に使う） */
export const DEFAULT_TITLE = '案件'

const isEmpty = (v) => v == null || (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && v !== null && Object.keys(v).length === 0)

/** 「2026/09」「2026年9月」等を YYYY-MM-01 に。読めなければ null（「即日」等は日付にしない） */
export function parseStartDate(s) {
  if (!s) return null
  const m = String(s).match(/(\d{4})\s*[\/年.\-]\s*(\d{1,2})/)
  if (!m) return null
  const y = +m[1], mo = +m[2]
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12) return null
  return `${y}-${String(mo).padStart(2, '0')}-01`
}

/** 数値の妥当性ガード（単価: 万円/月、精算: 時間、人数） */
const intIn = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null)

/**
 * 案件1件分のパッチを組み立てる。
 * @param p 現在の projects 行（raw_data 含む）
 * @param f LLM抽出の projects[0]（extractProjectFields の1要素）
 * @param skillMasterNormSet skill_master の正規化キー集合（required_skills 追加判定用）
 * @returns { patch, changes } — changes が空なら DB を触らない
 */
export function buildProjectPatch(p, f, skillMasterNormSet) {
  const rd = { ...(p.raw_data || {}) }
  const changes = []
  const backup = { ...(rd._regex_backup || {}) }
  const top = {}
  const stash = (key, val) => { if (!(key in backup)) backup[key] = val ?? null }

  const set = (key, val, { raw = false } = {}) => {
    if (isEmpty(val)) return
    const cur = raw ? rd[key] : p[key]
    const curEmpty = key === 'title' ? (isEmpty(cur) || cur === DEFAULT_TITLE) : isEmpty(cur)
    if (PROJECT_FIELD_POLICY[key] !== 'overwrite' && !curEmpty) return
    if (String(cur ?? '') === String(val)) return
    stash(key, cur)
    if (raw) rd[key] = val; else top[key] = val
    changes.push(key)
  }

  set('title', typeof f.title === 'string' ? f.title.trim().slice(0, 120) : null)
  set('client', f.client)
  set('budget_min', intIn(f.rateMin, 5, 500))
  set('budget_max', intIn(f.rateMax, 5, 500))
  set('start_date', parseStartDate(f.startDate))
  set('work_location', f.workLocation)
  // remotePolicy はリモート/出社関連の語を含む場合のみ受理
  // （ドライランで「派遣が必要」を remote_policy に転記した実例があった）
  const rp = typeof f.remotePolicy === 'string' &&
    /リモート|出社|常駐|在宅|テレワーク|ハイブリッド|フル出社|週\s*\d/.test(f.remotePolicy)
    ? f.remotePolicy : null
  set('remote_policy', rp)
  set('contract_type', f.contractType)
  set('headcount', intIn(f.headcount, 1, 500))
  set('workload', f.workload)
  set('settlement_min', intIn(f.settlementMin, 0, 744))
  set('settlement_max', intIn(f.settlementMax, 0, 744))
  set('role_summary', f.roleSummary)
  set('industry', f.industry)
  set('niceToHaveSkills', Array.isArray(f.niceToHaveSkills) ? f.niceToHaveSkills.filter(Boolean) : null, { raw: true })

  // requiredSkillYears: {"Java":[5]} 形式のみ受理（マッチングの skillYearsMatch が読む形）
  const rsy = f.requiredSkillYears
  if (rsy && typeof rsy === 'object' && !Array.isArray(rsy)) {
    const cleaned = {}
    for (const [k, v] of Object.entries(rsy)) {
      const years = Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 40) : []
      if (k.trim() && years.length) cleaned[k.trim()] = years
    }
    set('requiredSkillYears', Object.keys(cleaned).length ? cleaned : null, { raw: true })
  }

  // required_skills は skill_master にある未登録スキルの追加のみ
  if (Array.isArray(f.requiredSkills) && f.requiredSkills.length && skillMasterNormSet) {
    const merged = mergeSkills(p.required_skills, f.requiredSkills, skillMasterNormSet)
    if (merged) {
      stash('required_skills', p.required_skills ?? null)
      top.required_skills = merged
      changes.push(`required_skills(+${merged.length - (p.required_skills?.length ?? 0)})`)
    }
  }

  if (!changes.length) return { patch: null, changes }

  rd._regex_backup = backup
  rd._llm_applied = {
    at: new Date().toISOString(),
    model: f._model ?? null,
    fields: changes,
  }
  return { patch: { ...top, raw_data: rd }, changes }
}

/** normTech の再輸出（dryrun スクリプト用） */
export { normTech }
