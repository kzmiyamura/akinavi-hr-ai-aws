/** error_visibility.mjs の型（テストが normalizeMessage を直接検証するため） */
import type { RawFinding } from '../lib/diff.d.mts'

export function normalizeMessage(msg: unknown): string

declare const detector: {
  id: string
  title: string
  run(): RawFinding[]
}
export default detector
