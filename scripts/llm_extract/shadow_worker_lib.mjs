// shadow_worker_lib.mjs — shadow_worker.mjs の純粋関数（テスト用に env なしで読める場所へ切り出し）
//
// shadow_worker.mjs は起動時に SUPABASE_URL 等を要求するため、
// 単体テストから読めるようロジックだけをここに置き、worker からは import して使う。

/**
 * LLM に渡す本文を絞る。署名・法務定型文・URL は抽出に使わないのに毎回トークンを食う
 * （本文1件 $0.032・入力13,000tok に対し本文自体は4,000tok 程度だった・2026-08-10）。
 * 人物情報は本文前半にあるため、定型文以降は落として上限も下げる。
 */
export function trimBodyForLlm(text) {
  let t = String(text ?? '')
  // 署名・定型文の開始位置で打ち切る（最初に現れたもの）。
  // 300字より手前は本文の飾り罫線の可能性があるため対象外にする
  const CUT = [
    /^[-－—ー=＝*＊_]{8,}$/m, /配信停止/, /本メールは.{0,10}送信/, /個人情報の取扱/,
    /秘密保持/, /【重要：要員情報の利用範囲/, /このメールは、宛先として/, /免責事項/,
  ]
  let cut = t.length
  for (const re of CUT) {
    const m = t.match(re)
    if (m && m.index != null && m.index > 300 && m.index < cut) cut = m.index
  }
  t = t.slice(0, cut)
  t = t.replace(/https?:\/\/\S+/g, '(URL)')      // URLは判断に使わない
  return t.slice(0, 6000)
}

/**
 * app_config.llm_filter_skills の値をスキル名の配列に解く。
 * value は jsonb だが '"true"' のように文字列で二重に入っている実例があるため2回まで解く。
 * 配列として解けなければ null（＝絞り込みなし・全件対象）。
 */
export function parseSkillFilterValue(value) {
  let v = value
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  if (!Array.isArray(v)) return null
  const list = v.map((s) => String(s ?? '').trim()).filter(Boolean)
  return list.length ? list : null
}

/**
 * スキル絞り込みの PostgREST 条件を組み立てる。
 *
 * 一致判定は2本立て:
 *   ① skills 列 … regex抽出済みで skill_master 照合を通っているため表記ゆれに強い
 *   ② メール本文 … skills が空（regexが取れなかった）人材を落とさないための保険
 *
 * ②は部分一致なので "Java" は "JavaScript" にも当たる。絞りが甘くなるが、
 * 該当者を落とすと営業機会を失うため多めに拾う側に倒している。
 * 値だけを encode する（カンマ・括弧・ドットは PostgREST の構文なので壊さない）。
 */
export function buildSkillFilterClause(list) {
  if (!list?.length) return ''
  const terms = []
  for (const s of list) {
    terms.push(`skills.cs.${encodeURIComponent(JSON.stringify([s]))}`)
    terms.push(`raw_profile->>text.ilike.${encodeURIComponent(`*${s}*`)}`)
  }
  return `&or=(${terms.join(',')})`
}

/**
 * 案件の主要項目が既に埋まっていれば LLM を省く（候補者側 bodyLooksComplete と同思想）。
 * 案件サイクルには充足ゲートが無く、全項目が埋まっていても毎回 Haiku を呼んでいた（2026-08-10）。
 *
 * 判定を厳しめ（＝省略しにくい）にしてあるのは、取りこぼしよりコストの方が安いため:
 * - title は inbound-email のフォールバック値 DEFAULT_TITLE のとき未入力扱い（project_apply.mjs と同じ）
 * - required_skills はマッチング精度に直結するので、空なら必ず LLM を通す
 */
export function projectLooksComplete(p, defaultTitle = '案件') {
  return !!(p?.title && p.title !== defaultTitle && p.client &&
    p.budget_min && p.budget_max && p.work_location && p.contract_type &&
    p.required_skills?.length)
}
