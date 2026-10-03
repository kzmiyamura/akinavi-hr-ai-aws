/**
 * 検出器⑤「氏名として成立していない人材」
 *
 * 一覧に「オープン系」「昭和３３年５月１３日」「氏名」が人の名前として並ぶと、
 * **それだけで製品の信頼を失う**（2026-08-10 ユーザー指摘）。
 *
 * ## なぜ健診に移したか
 *
 * 判定そのものは `scripts/audit_bad_names.mjs` に前からあった。
 * だが**あれは prod を引く**（`candidates` を全件ページング）。
 * CLAUDE.md の egress 鉄則に引っかかるので日常的に回せず、誰も走らせていなかった。
 * 検出する力ではなく「控えで回る・自分で起きる・差分だけ鳴る」が足りていなかった。
 *
 * **判定は `scripts/lib/bad_names.mjs` の `badNameReasons` をそのまま import する。**
 * 書き写すと必ずズレる（手書きレプリカで実際にやらかしている）。
 *
 * ⚠ **`audit_bad_names.mjs` から import してはいけない。** あのファイルは
 *    モジュール先頭で `~/.akinavi_shadow.env` を読むので、
 *    秘密ファイルが無いマシンでは**この検出器が落ちる**（最初そう書いて直した）。
 *
 * ## 所見の粒度
 *
 * 1人1件にすると毎晩数十件出て本物が埋もれる。**理由ごとに1件**にまとめ、
 * `at` に「その理由で引っかかった中で一番新しい created_at」を入れる。
 * こうすると baseline に入れたあと**新しく増えたときだけ鳴る**
 * （lib/diff.mjs の seenAt 比較）。既にある分は静かになる。
 */

import { loadTable, prodOnly } from '../lib/archive.mjs'
import { badNameReasons } from '../../lib/bad_names.mjs'

/**
 * これ以上あったら出す、という下限は置かない。
 * 1件でも画面に出れば営業が見るので、0 件以外は所見にする。
 */
export default {
  id: 'bad-names',
  title: '氏名として成立していない人材（一覧にそのまま並ぶ）',

  run() {
    const rows = loadTable('candidates')
    if (!rows) {
      return [{
        key: 'archive-missing:candidates',
        severity: 'warn',
        title: '控えに candidates が無く、氏名の検査ができない',
        detail: 'node scripts/archive_local.mjs を先に走らせる。**所見ゼロを健康と読まないこと。**',
      }]
    }

    const prod = prodOnly(rows).filter((r) => !r.merged_into)
    /** 理由 -> {n, newest, samples[]} */
    const byReason = new Map()
    for (const c of prod) {
      for (const reason of badNameReasons(c.name)) {
        // 「長すぎる(29字)」の字数は人ごとに違う。指紋が人数ぶん増えるので丸める
        const kind = reason.replace(/\(\d+字\)/, '')
        if (!byReason.has(kind)) byReason.set(kind, { n: 0, newest: null, samples: [] })
        const e = byReason.get(kind)
        e.n++
        if (c.created_at && (!e.newest || c.created_at > e.newest)) e.newest = c.created_at
        if (e.samples.length < 3) e.samples.push(String(c.name ?? '').slice(0, 24))
      }
    }

    const findings = []
    for (const [kind, e] of [...byReason].sort((a, b) => b[1].n - a[1].n)) {
      findings.push({
        key: `bad-name:${kind}`,
        // プレースホルダ（「不明」「氏名」）は AI 校正で埋まる見込みがあるが、
        // スキル分類や元号が名前になっているのは**抽出の取り違え**で、直さないと消えない
        severity: /スキル分類|元号|文字なし/.test(kind) ? 'warn' : 'info',
        at: e.newest,
        title: `氏名が「${kind}」の人材が prod ${e.n} 人いる`,
        detail: `例: ${e.samples.join(' / ')}。prod ${prod.length} 人中 ${e.n} 人。`
          + `一覧にこのまま並ぶので、営業がその行を見た時点で信頼を落とす。`
          + `新しいものは ${e.newest ?? '不明'} に入っている。`,
      })
    }
    return findings
  },
}
