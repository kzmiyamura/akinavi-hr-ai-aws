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
  // 体制の人数表現は募集役割として意味を持たないので捨てる。
  // 実害: 「PLとメンバーの合計3名は弊社から参画」から roleSummary="メンバー" を拾い、
  // 案件見出しが「メンバー を 1名」になった。同じ案件の再送版は「保守開発」と取れており揺れる。
  // ヘルプデスク・開発および保守 のような正しい値を落とさないよう、白リストではなく除外語で判定する
  const MEANINGLESS_ROLE = /^(メンバー|メンバ|要員|担当者?|増員|スタッフ|人員|作業者)$/
  const roleSummary = typeof f.roleSummary === 'string' && !MEANINGLESS_ROLE.test(f.roleSummary.trim())
    ? f.roleSummary
    : null
  set('role_summary', roleSummary)
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

  // required_skills は「regex が1件も取れなかったときだけ」LLM の結果で埋める（他項目と同じ fill）。
  //
  // 以前は人材の skills と同じ「追加のみ」だったが、実データ8件で測ると役に立ったのは
  // required_skills が空だった1件だけで、既に入っている案件への追加は全部ノイズだった
  // （Azure Functions があるのに AzureFunction、システム側のヘルプデスク があるのに ヘルプデスク）。
  // normTech は空白と大文字小文字しか吸収しないため、この手の表記ゆれは重複として弾けない。
  // 必須スキルが増えると「何件中いくつ一致したか」の分母が膨らみ、同じ候補者でもスコアが
  // 下がるので、取りこぼしを埋める効果よりも害が大きい。
  const hasRegexSkills = Array.isArray(p.required_skills) && p.required_skills.length > 0
  if (!hasRegexSkills && Array.isArray(f.requiredSkills) && f.requiredSkills.length && skillMasterNormSet) {
    const merged = mergeSkills(p.required_skills, f.requiredSkills, skillMasterNormSet)
    if (merged) {
      stash('required_skills', p.required_skills ?? null)
      top.required_skills = merged
      changes.push(`required_skills(${merged.length}件・regexが0件のため補完）`)
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

/**
 * 案件条件のAI解釈（extractProjectInterpretation の結果）を raw_data パッチにする。
 *
 * 方針（2026-08-13 ユーザー合意・HANDOFF.md §0）:
 *  - スコア計算はルールのまま。AIが足すのは「複数名前提フラグ」と「関連スキル」だけ
 *  - 関連スキルは尚可扱い（niceToHaveSkills に統合）。必須の分母は増やさない
 *  - AIが何を足したかは raw_data.aiInterpretation に残し、画面で見える形にする
 *  - aiInterpretation は結果ゼロでも必ず書く（ワーカーの「1回だけ」の印を兼ねる）
 *
 * 関連スキルの受け入れ条件:
 *  - skill_master にある技術名のみ（無いものは skill_satisfies が判定できず足しても効かない）
 *  - 必須・既存尚可と正規化キーが重複しないもののみ（転記の言い換えは解釈ではない）
 *  - confidence が low のときは記録だけして適用しない
 */
export function buildInterpretationPatch(p, r, skillMasterNormSet) {
  const rd = { ...(p.raw_data || {}) }
  const changes = []
  const lowConf = r.confidence === 'low'

  const existingKeys = new Set(
    [...(p.required_skills ?? []), ...(Array.isArray(rd.niceToHaveSkills) ? rd.niceToHaveSkills : [])]
      .map(normTech).filter(Boolean))
  const related = []
  for (const s of r.relatedSkills ?? []) {
    const name = typeof s?.name === 'string' ? s.name.trim() : ''
    if (!name) continue
    const k = normTech(name)
    if (!k || existingKeys.has(k)) continue
    if (skillMasterNormSet && !skillMasterNormSet.has(k)) continue
    existingKeys.add(k)
    related.push({ name, reason: typeof s?.reason === 'string' ? s.reason.trim().slice(0, 60) : null })
    if (related.length >= 8) break
  }

  const multiPerson = !lowConf && r.multiPerson === true
  rd.aiInterpretation = {
    at: new Date().toISOString(),
    model: r.model ?? null,
    confidence: r.confidence ?? null,
    multiPerson,
    evidence: multiPerson ? (r.evidence ?? null) : null,
    relatedSkills: lowConf ? [] : related,
  }

  if (!lowConf && related.length) {
    const cur = Array.isArray(rd.niceToHaveSkills) ? rd.niceToHaveSkills : []
    const backup = { ...(rd._regex_backup || {}) }
    if (!('niceToHaveSkills' in backup)) backup.niceToHaveSkills = cur
    rd._regex_backup = backup
    rd.niceToHaveSkills = [...cur, ...related.map((x) => x.name)]
    changes.push(`関連スキル+${related.length}(尚可扱い)`)
  }
  if (multiPerson) changes.push('複数名前提')
  if (lowConf) changes.push('低確信のため未適用')

  return { patch: { raw_data: rd }, changes }
}

/** normTech の再輸出（dryrun スクリプト用） */
export { normTech }
