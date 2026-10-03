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
}

export interface Finding {
  fp: string
  detector: string
  severity: 'error' | 'warn' | 'info'
  title: string
  detail: string
}

export interface BaselineEntry {
  why: string
  at: string
  was?: string
}

export type Baseline = Record<string, BaselineEntry>

export function fingerprint(detectorId: string, key: string): string
export const SEVERITY_ORDER: Record<string, number>
export function withFingerprints(detector: { id: string }, raw: RawFinding[]): Finding[]
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
