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
 * 本文LLMを省略してよいか。
 *
 * regex が主要項目を埋めていれば省略する、という判定だけだと、
 * 添付が無い人材まで省略されて本文からしか取れない項目を永久に取り逃す。
 * 本文由来にしかない情報:
 *   ・総経験年数の申告値（案件表は前職・研修が載らず過小評価になる）
 *   ・商流（自社 / N社先）
 *   ・スキル年数（添付が無ければ唯一の情報源）
 *
 * 実測（2026-08-11）: _experience_source を持つ45件のうち申告値が入ったのは2件だけ。
 * うち T.A は案件表6年に対し申告24年で、18年分の取りこぼしが埋まった。
 * 添付がある人材は案件表から取れるので従来どおり省略してよい。
 *
 * @param resumeUrl 経歴書のURL（解析可能な拡張子かどうかで判断する）
 * @param bodyComplete regex が本文の主要項目を埋めているか（bodyLooksComplete の結果）
 */
export function shouldSkipBodyLlm(resumeUrl, bodyComplete) {
  const hasAttachment = /\.(xlsx?|xlsm|docx?|pdf)(?:$|\?)/i.test(String(resumeUrl ?? ''))
  return hasAttachment && !!bodyComplete
}

/**
 * その時刻までに使ってよい処理件数（日次上限を24時間に均したもの）。
 *
 * 上限だけを置くと、ワーカーは能力いっぱいで走って朝の数時間で使い切る
 * （実測 1件あたり約123秒＝100件で約3.4時間）。すると営業時間中に届いた人材が
 * 当日中に処理されず、「新しい順に処理して価値を上げる」という設計の利点が消える。
 *
 * 日境界は state.day と同じ UTC 0時。経過割合に比例した上限を返す。
 * ワーカーが停止していた場合は経過時間ぶんの余裕が自然に溜まるので、再開後に追いつける。
 */
export function pacedAllowance(maxPerDay, now = new Date()) {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const ratio = (now.getTime() - dayStart) / 86_400_000
  const clamped = Math.min(1, Math.max(0, ratio))
  // 起動直後（ratio≒0）でも1件は動かす。完全に止まっていると障害と区別できないため
  return Math.max(1, Math.min(maxPerDay, Math.ceil(maxPerDay * clamped)))
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

/** 語境界とみなさない文字。CLAUDE.md §6 の skill_satisfies と同じ集合
 *  （英数字・`#`・`+` に挟まれていたら別の語）。 */
const PG_WORD_CHARS = 'a-zA-Z0-9#+'

/** PostgreSQL の正規表現メタ文字を無害化する。
 *  バックスラッシュを使うと PostgREST の二重引用符内でさらにエスケープが要るので、
 *  1文字のブラケット式（`[.]` 等）に置き換える。`]` は先頭に置く必要があるため `[]]`。
 *  バックスラッシュと二重引用符を含むスキル名は表現できないので null を返す（呼び側で従来の部分一致に退避）。 */
export function pgRegexEscape(s) {
  let out = ''
  for (const c of s) {
    if (c === '\\' || c === '"') return null
    if (c === ']') out += '[]]'
    else if ('.^$*+?()[{}|-'.includes(c)) out += `[${c}]`
    else out += c
  }
  return out
}

/** 本文からスキル名を「語として」拾う PostgreSQL 正規表現。
 *  `Java` が `JavaScript` に、`C` が `C#` に当たらない。
 *  フロント側の同等実装は src/lib/skillWordMatch.ts（両方直すこと）。 */
export function pgSkillWordPattern(skill) {
  const esc = pgRegexEscape(skill)
  if (esc === null) return null
  return `(^|[^${PG_WORD_CHARS}])${esc}([^${PG_WORD_CHARS}]|$)`
}

/**
 * スキル絞り込みの PostgREST 条件を組み立てる。
 *
 * 一致判定は2本立て:
 *   ① skills 列 … regex抽出済みで skill_master 照合を通っているため表記ゆれに強い
 *   ② メール本文 … skills が空（regexが取れなかった）人材を落とさないための保険
 *
 * ②はかつて `ilike *Java*` の部分一致で、**本文に JavaScript があるだけの人材が
 * Java 枠でキューに入っていた**（2026-08-14 実測: 直近3日 prod で 637→561人＝76人が誤ヒット）。
 * CLAUDE.md §6 の「部分一致は使わない」に合わせ、語境界付きの正規表現（imatch）にした。
 *
 * 値だけを encode する（カンマ・括弧・ドットは PostgREST の構文なので壊さない）。
 * 正規表現自体が括弧・カンマを含むため、値は二重引用符で囲んで構文と切り分ける。
 */
export function buildSkillFilterClause(list) {
  if (!list?.length) return ''
  const terms = []
  for (const s of list) {
    terms.push(`skills.cs.${encodeURIComponent(JSON.stringify([s]))}`)
    const pattern = pgSkillWordPattern(s)
    // 正規表現化できない名前だけ従来の部分一致に退避（取りこぼしより甘さを取る）
    if (pattern === null) terms.push(`raw_profile->>text.ilike.${encodeURIComponent(`*${s}*`)}`)
    else terms.push(`raw_profile->>text.imatch."${encodeURIComponent(pattern)}"`)
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
