/**
 * 所見に指紋を付け、baseline と突き合わせて**新規だけ**を残す。
 *
 * ここが夜間健診の心臓。既知の所見を毎晩読み直させるとトークンが溶けるので、
 * **昨日無くて今日あるもの**しか先に進ませない。
 * 純関数だけにして src/lib/__tests__/selfcheckDiff.test.ts で検証する。
 */

/** 指紋。検出器 ID と、検出器が決めた安定キーの組 */
export function fingerprint(detectorId, key) {
  return `${detectorId}/${key}`
}

export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 }

/**
 * @param {{id: string}} detector
 * @param {{key: string, severity?: string, title: string, detail?: string}[]} raw
 */
/**
 * 指紋を付ける。**同じ指紋が2件来たら落とし、落とした数を返す。**
 *
 * ⚠ 黙って残すと「1件を accept したら残りも黙る」ことになり、
 *    2件目以降が永久に鳴らない。検出器側の作りの間違いなので見えるようにする
 *    （reference_errors が初回にこれをやった: 同じ型エラーの2か所が同じ指紋だった）。
 *
 * @returns {{findings: object[], dupes: string[]}}
 */
export function withFingerprintsChecked(detector, raw) {
  const seen = new Set()
  const findings = []
  const dupes = []
  for (const f of raw ?? []) {
    const fp = fingerprint(detector.id, f.key)
    if (seen.has(fp)) { dupes.push(fp); continue }
    seen.add(fp)
    findings.push({
      fp,
      detector: detector.id,
      severity: f.severity ?? 'warn',
      title: f.title,
      detail: f.detail ?? '',
      // 最終発生時刻。**再発したら黙らせを解除する**ために baseline へ持ち越す
      // （持っていない検出器は undefined のままでよい）
      ...(f.at ? { at: String(f.at) } : {}),
    })
  }
  return { findings, dupes }
}

/** 重複を気にしない呼び出し口（テストと既存の呼び出し用） */
export function withFingerprints(detector, raw) {
  return withFingerprintsChecked(detector, raw).findings
}

/**
 * baseline と突き合わせる。
 *
 * baseline は `{ "<指紋>": { "why": "…", "at": "YYYY-MM-DD" } }`。
 * **why を必ず書く。** 理由の無い黙らせは、半年後に誰も解除できない。
 *
 * @returns {{fresh: object[], known: object[], stale: string[]}}
 *   fresh … 新規（人／Claude を起こす）
 *   known … baseline 済み（静かに数えるだけ）
 *   stale … baseline にあるが今は出ない指紋（直ったので消してよい）
 */
export function diffAgainstBaseline(findings, baseline) {
  const accepted = baseline ?? {}
  const fresh = []
  const known = []
  const seen = new Set()
  for (const f of findings) {
    seen.add(f.fp)
    const acc = Object.prototype.hasOwnProperty.call(accepted, f.fp) ? accepted[f.fp] : null
    if (!acc) { fresh.push(f); continue }
    // ⚠ **「直したから黙らせた」を永久の黙秘にしないこと。**
    //   ai_logs のエラーは控えに残り続けるので、直して受け入れると指紋がずっと既知になる。
    //   そのままだと**同じバグが再発しても二度と鳴らない**（一番やってはいけない形）。
    //   受け入れたときの最終発生時刻（`seenAt`）より新しい発生があれば、再び新規として出す。
    if (acc.seenAt && f.at && String(f.at) > String(acc.seenAt)) {
      fresh.push({ ...f, recurredSince: acc.seenAt })
      continue
    }
    known.push(f)
  }
  fresh.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.fp.localeCompare(b.fp))
  const stale = Object.keys(accepted).filter((fp) => !seen.has(fp)).sort()
  return { fresh, known, stale }
}

/**
 * 終了コード。free_plan_watch.mjs と同じ約束にする（.cmd 側が同じ扱いで書ける）。
 *   0 … 新規なし
 *   1 … 新規あり
 *   2 … 検出器が落ちた（健診そのものが壊れている＝一番まずい）
 */
export function exitCodeFor({ fresh, crashed }) {
  if (crashed?.length) return 2
  return fresh.length ? 1 : 0
}

/**
 * baseline へ追記する形を作る（上書きはしない。既存の why を消さないため）。
 *
 * 所見が最終発生時刻（`at`）を持っているなら `seenAt` として一緒に残す。
 * これが無いと「直したから黙らせた」が**再発しても黙ったまま**になる
 * （`diffAgainstBaseline` を参照）。
 */
export function acceptInto(baseline, findings, why, today) {
  const next = { ...(baseline ?? {}) }
  for (const f of findings) {
    if (next[f.fp]) continue
    next[f.fp] = { why, at: today, was: f.title.slice(0, 120) }
    if (f.at) next[f.fp].seenAt = String(f.at)
  }
  return next
}
