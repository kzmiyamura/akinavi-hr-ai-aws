/**
 * diff.mjs の型。テスト（src/lib/__tests__/selfcheckDiff.test.ts）から import するため。
 * ⚠ `vercel.json` の buildCommand は `tsc -b && vite build` なので、
 *    型が付いていないと**フロントのデプロイが落ちる**。
 */

export interface RawFinding {
  key: string
  severity?: 'error' | 'warn' | 'info'
  title: string
  detail?: string
  /** その所見の最終発生時刻（持てる検出器だけ）。再発の判定に使う */
  at?: string | null
}

export interface Finding {
  fp: string
  detector: string
  severity: 'error' | 'warn' | 'info'
  title: string
  detail: string
  at?: string
  /**
   * baseline で黙らせた時点（`seenAt`）より新しい発生があった場合、その時点。
   * **「直したから黙らせた」を永久の黙秘にしないための印。**
   */
  recurredSince?: string
}

export interface BaselineEntry {
  why: string
  at: string
  was?: string
  /**
   * 黙らせた時点での最終発生時刻。これより新しい発生があれば再び新規として出す。
   * 古い baseline には無い（無ければ従来どおり黙る＝互換）。
   */
  seenAt?: string
}

export type Baseline = Record<string, BaselineEntry>

export function fingerprint(detectorId: string, key: string): string
export const SEVERITY_ORDER: Record<string, number>
export function withFingerprints(detector: { id: string }, raw: RawFinding[]): Finding[]
export function withFingerprintsChecked(
  detector: { id: string },
  raw: RawFinding[],
): { findings: Finding[]; dupes: string[] }
export function diffAgainstBaseline(
  findings: Finding[],
  baseline: Baseline | null | undefined,
): { fresh: Finding[]; known: Finding[]; stale: string[] }
export function exitCodeFor(arg: {
  fresh: unknown[]
  crashed?: unknown[] | null
}): 0 | 1 | 2
export function acceptInto(
  baseline: Baseline | null | undefined,
  findings: Finding[],
  why: string,
  today: string,
): Baseline
