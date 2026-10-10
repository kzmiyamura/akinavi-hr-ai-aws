// 通知ルール × 人材のマッチ判定（純関数・match_test.ts でテスト）

export interface NotifyRule {
  id: string
  label: string
  name_keyword: string
  skill_keywords: string[]
  station_keyword: string
  notify_email: string
  enabled: boolean
  data_env: string
  // ── 2026-10-01 追加。移行前に作られた行でも落ちないよう、すべて任意 ──────────
  /** 年齢の範囲（null = 指定なし）。「20代後半〜40代」は 25〜49 で表す */
  age_min?: number | null
  age_max?: number | null
  /** 経験年数の下限。実測で5年以上が88%なので**単独では絞りにならない** */
  experience_years_min?: number | null
  /** skill_keywords に挙げた技術のいずれかで、この年数以上あること */
  skill_years_min?: number | null
  /** 到達レベルCの印しか無い人を外す。A/B必須にはしない（印は51%にしか付かない） */
  exclude_level_c?: boolean | null
  /** 経歴本文のキーワード（OR）。スキル名では表せない実績（共通部品 等）を拾う */
  text_keywords?: string[] | null
  /** 値が取れていない人材を通すか（既定 true） */
  include_unknown?: boolean | null
}

export interface CandidateLite {
  id: string
  name: string
  /** 人が読める通し番号（candidates.candidate_no）。通知メールに出して口頭でも使えるようにする */
  candidateNo?: number | null
  skills: string[]
  /** 最寄駅 + 都道府県の連結（raw_profile.nearestStation / prefecture 由来） */
  station: string
  data_env: string
  /** 年齢（raw_profile.age）。取れていなければ null */
  age?: number | null
  /** 経験年数（candidates.experience_years）。取れていなければ null */
  experienceYears?: number | null
  /**
   * 技術ごとの経験**月数**（raw_profile.skillYears）。`_` 始まりの内部キーは含めない。
   * キー名は skillYears だが中身は月数（例: Visual Basic 84 ＝ 7年）
   */
  skillYears?: Record<string, number> | null
  /** 役割ごとの到達レベル（raw_profile._roleLevels）。実測で6役割にしか付かない */
  roleLevels?: Record<string, string> | null
  /** 経歴本文（添付テキスト＋自己PR）。本文キーワード条件の判定に使う */
  text?: string
}

/** 表記ゆれ吸収: 小文字化 + ピリオド・空白・中点・スラッシュ・ハイフンを除去
 *  （イニシャル T.K ≒ TK、`AS/400` ≒ `AS400` ≒ `AS-400`）。
 *  スラッシュとハイフンは 2026-08-17 に追加。大阪のルールが `AS/400` と `AS400` を
 *  別物として扱っていた */
function norm(s: string): string {
  return s.toLowerCase().replace(/[.\s　・/-]/g, '')
}

/** 語境界とみなさない文字。src/lib/skillWordMatch.ts / SQL の skill_satisfies と同じ集合 */
const WORD_CHARS = 'a-zA-Z0-9#+'

/**
 * スキル名が「語として」一致するか。
 *
 * CLAUDE.md §6 の鉄則「部分一致は使わない」が通知だけ適用されていなかった。
 * `norm(skill).includes(norm(keyword))` だったため、キーワード `Java` が
 * `JavaScript` を拾っていた（2026-08-21 実測: 大阪府の人材62人中48人が通知対象になり、
 * うち14人は JavaScript しか持っていない＝誤通知）。`Go` なら MongoDB・Django も拾う。
 *
 * 判定は二本立て:
 *  ① 語境界つきで含まれる  … `C#` は `C#.NET` に一致し、`Java` は `JavaScript` に一致しない
 *  ② 正規化して完全一致    … `AS400` ≡ `AS/400`（①は区切り文字を保つので拾えない）
 */
function skillMatches(keyword: string, skill: string): boolean {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordRe = new RegExp(`(^|[^${WORD_CHARS}])${esc}([^${WORD_CHARS}]|$)`, 'i')
  if (wordRe.test(skill)) return true
  return norm(keyword) === norm(skill)
}

/** 条件が1つも指定されていないルールは何にもマッチしない（全員通知の暴発防止） */
export function ruleHasCondition(rule: NotifyRule): boolean {
  return rule.name_keyword.trim() !== ''
    || rule.skill_keywords.some((k) => k.trim() !== '')
    || rule.station_keyword.trim() !== ''
    || rule.age_min != null
    || rule.age_max != null
    || rule.experience_years_min != null
    || rule.skill_years_min != null
    || rule.exclude_level_c === true
    || (rule.text_keywords ?? []).some((k) => k.trim() !== '')
}

/**
 * 値が取れていない人材をどう扱うか。既定は「通す」。
 *
 * skillYears は31%、到達レベルは49%が未取得（2026-10-01 実測）。
 * 既定で落とすと、条件を1つ足すたびに取りこぼしが増える。
 * 「取れていない＝条件を満たさない」ではないので、落とすのは明示されたときだけ。
 */
function passUnknown(rule: NotifyRule): boolean {
  return rule.include_unknown !== false
}

/**
 * その技術の経験**月数**。キーは表記ゆれがあるので正規化して引く。
 *
 * ⚠ `raw_profile.skillYears` は名前に反して**月数**が入っている
 * （`src/lib/skillYearsMatch.ts` の findSkillMonths / 画面は `Math.floor(months/12)年` と表示）。
 * 実データ例: `{ "Visual Basic": 84, "Python": 39 }` ＝ 7年 / 3年3か月。
 * ルール側（`skill_years_min`）は営業が入れる値なので**年**で持ち、ここで換算する。
 */
function monthsFor(cand: CandidateLite, keyword: string): number | null {
  const sy = cand.skillYears
  if (!sy) return null
  const want = norm(keyword)
  for (const [k, v] of Object.entries(sy)) {
    if (k.startsWith('_')) continue // 内部キー（_llm_checked_at 等）
    if (norm(k) === want || skillMatches(keyword, k)) {
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

/**
 * 到達レベルCの印しか無いか（＝「従事どまり」の人か）。
 *
 * A と C の両方が付く人がいる（役割ごとに別々に判定されるため）ので、
 * **C が1つでもあれば外す、にはしない。** A か B が1つでもあれば残す。
 * 印が1つも無い人は「判定できない」であって「Cである」ではないので null を返す。
 */
function isLevelCOnly(cand: CandidateLite): boolean | null {
  const lv = cand.roleLevels
  if (!lv) return null
  const vals = Object.values(lv).filter((v) => typeof v === 'string' && v !== '')
  if (vals.length === 0) return null
  if (vals.some((v) => v === 'A' || v === 'B')) return false
  return vals.some((v) => v === 'C')
}

/**
 * ルールに人材が合致するか。
 *
 * 種類の違う条件（名前・スキル・最寄駅）は AND＝指定したものをすべて満たす必要がある。
 * **スキルのキーワード同士は OR**（いずれか1つでも持っていればよい）。
 * スキルの照合は語単位（skillMatches）。名前・最寄駅は従来どおり部分一致でよい
 * （「大阪府」で大阪の人を、「TK」で T.K さんを拾う用途のため）。
 *
 * スキルは 2026-08-17 に AND から OR へ変更した。営業が登録した
 * 「大阪府 / C#, Java, AS/400, AS400」は「大阪でこのどれかができる人」の意図だったが、
 * AND では4つすべてを持つ人が要求され、該当0名のまま通知が1件も出ていなかった
 * （実データで確認: 大阪府の1名は C# と Java を持つが AS400 は持たない）。
 */
/**
 * ルールのどのスキルに合致したかを返す（通知メールに根拠を出すため）。
 *
 * 2026-09-01、営業から「C#でもJavaでもない人に通知が飛んでいる」と指摘があった。
 * 実際には24個のスキルの23番目に Java があり、判定は正しかったが、
 * メールがスキルを先頭10件しか出しておらず、根拠が見えなかった。
 * 正しい通知を誤検知だと思わせるのは、通知そのものの信頼を損なう。
 */
export function matchedSkills(rule: NotifyRule, cand: CandidateLite): string[] {
  const kws = rule.skill_keywords.map((k) => k.trim()).filter((k) => k !== '')
  const hits: string[] = []
  for (const s of cand.skills) {
    if (kws.some((kw) => skillMatches(kw, s))) hits.push(s)
  }
  return hits
}

export function matchesRule(rule: NotifyRule, cand: CandidateLite): boolean {
  if (!ruleHasCondition(rule)) return false
  if (rule.data_env !== cand.data_env) return false
  if (rule.name_keyword.trim() !== '') {
    if (!norm(cand.name).includes(norm(rule.name_keyword))) return false
  }
  const kws = rule.skill_keywords.map((k) => k.trim()).filter((k) => k !== '')
  if (kws.length > 0) {
    const hit = kws.some((kw) => cand.skills.some((s) => skillMatches(kw, s)))
    if (!hit) return false
  }
  if (rule.station_keyword.trim() !== '') {
    if (!norm(cand.station).includes(norm(rule.station_keyword))) return false
  }

  // ── ここから 2026-10-01 追加の条件。種類の違う条件どうしは従来どおり AND ────────
  const unknownOk = passUnknown(rule)

  // 年齢（実測98.1%が取得済み）
  if (rule.age_min != null || rule.age_max != null) {
    if (cand.age == null) {
      if (!unknownOk) return false
    } else {
      if (rule.age_min != null && cand.age < rule.age_min) return false
      if (rule.age_max != null && cand.age > rule.age_max) return false
    }
  }

  // 経験年数（実測98.1%が取得済み。ただし5年以上が88%なので単独では絞れない）
  if (rule.experience_years_min != null) {
    if (cand.experienceYears == null) {
      if (!unknownOk) return false
    } else if (cand.experienceYears < rule.experience_years_min) {
      return false
    }
  }

  // 指定スキルでの年数（skill_keywords のいずれか1つが満たせばよい＝スキル条件と同じ OR）。
  // ルールは「年」、データは「月」なので 12 倍して比べる
  if (rule.skill_years_min != null && kws.length > 0) {
    const needMonths = rule.skill_years_min * 12
    let decided = false
    let ok = false
    for (const kw of kws) {
      const m = monthsFor(cand, kw)
      if (m == null) continue // その技術の年数が取れていない
      decided = true
      if (m >= needMonths) { ok = true; break }
    }
    if (decided) {
      if (!ok) return false
    } else if (!unknownOk) {
      return false // 年数が1つも取れていない（実測31%）
    }
  }

  // 到達レベル C（従事どまり）の除外
  if (rule.exclude_level_c === true) {
    const cOnly = isLevelCOnly(cand)
    if (cOnly === true) return false
    if (cOnly === null && !unknownOk) return false
  }

  // 経歴本文のキーワード。本文が渡されていないとき（undefined）はここでは判定せず、
  // 呼ぶ側が絞ったあとに matchesText で見る（本文は重いので後段で引くため）
  if (cand.text !== undefined && !matchesText(rule, cand.text)) return false

  return true
}

/** ルールが経歴本文の条件を持っているか（本文を引くべきかの判定に使う） */
export function ruleNeedsText(rule: NotifyRule): boolean {
  return (rule.text_keywords ?? []).some((k) => k.trim() !== '')
}

/**
 * 経歴本文のキーワード条件（OR）。日本語なので語境界は使わず、正規化した部分一致。
 *
 * ⚠ **本文は他の条件を全部通った人にだけ引く。** 経歴本文は1人あたり12KBあり、
 * 5分ごとの全対象（実測 2,207行/日）ぶん引くと月1.3GBになる。
 * 呼ぶ側（index.ts）は matchesRule で絞ってから、残った数人ぶんだけ本文を取得する。
 *
 * text が空文字なのは「本文が無い人」（実測24.3%）。取れていないだけなので、
 * 落とすかどうかは include_unknown に従う。
 */
export function matchesText(rule: NotifyRule, text: string): boolean {
  const tkws = (rule.text_keywords ?? []).map((k) => k.trim()).filter((k) => k !== '')
  if (tkws.length === 0) return true
  if (text.trim() === '') return passUnknown(rule)
  const nt = norm(text)
  return tkws.some((k) => nt.includes(norm(k)))
}
