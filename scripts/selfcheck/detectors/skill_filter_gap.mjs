/**
 * 検出器⑥「本文に優先スキルがあるのに skills 列に無い人材」
 *
 * 人材画面の優先スキル絞り込みは**二本立て**で当てている
 * （`src/lib/skillWordMatch.ts` の `skillFilterOrTerms`）:
 *
 *   1. `skills` 列の完全一致（索引が効く）
 *   2. `raw_profile->>text` の語一致（**索引が効かない＝全行の本文を走る**）
 *
 * 2番目を外したい、という話が何度も出る。外してよいかは
 * **「2番目だけで当たっている人が何人いるか」**で決まる。
 *
 * ## 2026-10-04 に測った結論
 *
 * 控え 8,225人のうち本文だけで当たるのは 221人。だが**全員が
 * 2026-09-17 より前に登録された行**だった。その日の修正
 * （複数人メールで `raw_profile.text` を**自分のブロックだけ**にする）以降は
 * **4,188人中 0人**。prod は7日保持なので、今の prod に該当者は1人もいない。
 *
 * つまり 2番目は「今は誰も足していないが、**抽出が壊れた瞬間に効き始める保険**」。
 * だから**外さない**。外す代わりに、効き始めたら鳴るようにしたのがこの検出器。
 *
 * ⚠ 一度こう書き間違えた: 「221人は抽出の取りこぼしだから述語は必要」。
 *   実際は**複数人メールで他人のスキルに当たっていた**（本文を18人で共有していた）。
 *   `created_at` で切らずに測ると、直った後も壊れているように見える。
 *
 * ## 鳴ったときの読み方
 *
 * 「本文に Java と書いてあるのに skills 列に Java が無い」＝ skill_master 照合か
 * 本文の保存のどちらかが壊れている。どちらも**絞り込みから人が消える**side effect を持つ。
 */

import { loadTable, prodOnly, appConfig } from '../lib/archive.mjs'

/** 既定の優先スキル（app_config.llm_filter_skills が未作成のときのコード側既定） */
const FALLBACK_SKILLS = ['Java', 'C#', 'Python', 'JavaScript', 'PHP']

/**
 * 語境界。**`src/lib/skillWordMatch.ts` と同じ集合でなければ測れない。**
 *
 * ⚠ 直前の `.` を禁じるのを忘れないこと。忘れると `…/cc.php?t=…` のような
 *   配信停止リンクが PHP として当たり、**実測で 56人中54人が URL** になる
 *   （2026-10-04 に archive_query 側で実際にやらかした。「同じ規則」と
 *   コメントに書いて中身が違うのが一番危ない）。
 */
const WORD_CHARS = 'a-zA-Z0-9#+'
const wordRe = (skill) => new RegExp(
  `(^|[^${WORD_CHARS}.])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^${WORD_CHARS}]|$)`, 'i',
)

export default {
  id: 'skill-filter-gap',
  title: '優先スキルが本文にあるのに skills 列に入っていない人材',

  run() {
    const rows = loadTable('candidates')
    if (!rows) {
      return [{
        key: 'archive-missing:candidates',
        severity: 'warn',
        title: '控えに candidates が無く、絞り込みの穴を検査できない',
        detail: 'node scripts/archive_local.mjs を先に走らせる。**所見ゼロを健康と読まないこと。**',
      }]
    }

    const cfg = appConfig('llm_filter_skills')
    const skills = (Array.isArray(cfg) ? cfg : FALLBACK_SKILLS).map((s) => String(s)).filter(Boolean)
    if (!skills.length) return []
    const res = skills.map((s) => ({ s, re: wordRe(s) }))

    const prod = prodOnly(rows).filter((r) => !r.merged_into)
    let n = 0
    let newest = null
    const perSkill = new Map()
    const samples = []
    for (const c of prod) {
      const have = (Array.isArray(c.skills) ? c.skills : []).map((x) => String(x).toLowerCase())
      if (res.some(({ s }) => have.includes(s.toLowerCase()))) continue
      const body = c.rp_text ?? c.raw_profile?.text ?? ''
      if (!body) continue
      const hit = res.filter(({ re }) => re.test(body))
      if (!hit.length) continue
      n++
      for (const { s } of hit) perSkill.set(s, (perSkill.get(s) ?? 0) + 1)
      if (c.created_at && (!newest || c.created_at > newest)) newest = c.created_at
      if (samples.length < 3) samples.push(`${c.name ?? '(名前なし)'}→${hit.map((h) => h.s).join(',')}`)
    }
    if (!n) return []

    const breakdown = [...perSkill].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join(' / ')
    return [{
      // 指紋は人数を含めない（1人増えるたびに別の所見になってしまう）
      key: 'body-only-skill-match',
      severity: 'warn',
      // baseline に入れたあと、**これより新しい登録で再発したときだけ鳴る**
      at: newest,
      title: `優先スキルが本文にあるのに skills 列に無い人材が prod ${n} 人いる`,
      detail: `対象スキル: ${skills.join(', ')}。内訳: ${breakdown}。例: ${samples.join(' / ')}。`
        + `prod ${prod.length} 人中 ${n} 人。新しいものは ${newest ?? '不明'}。`
        + `この人たちは skills 列では絞り込みに出ず、**索引の効かない本文照合だけで拾えている**。`
        + `増えているなら skill_master 照合か本文の保存が壊れている（2026-09-17 以降の登録なら新しいバグ）。`,
    }]
  },
}
