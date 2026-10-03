/**
 * 夜間健診（scripts/selfcheck）の心臓部のテスト。
 *
 * ⚠ ここが壊れると**所見ゼロが「健康」に見える**。この健診そのものが
 *    「保険が機能していない」側に回る。検出器を足すより先にここを守る。
 *
 * 検出器の本体はリポジトリ全体とローカル控えを読むので、ここでは
 * 純関数（指紋・差分・文面の正規化）と、落ちずに走ることだけを見る。
 */
import { describe, it, expect } from 'vitest'
import {
  fingerprint, withFingerprints, withFingerprintsChecked,
  diffAgainstBaseline, exitCodeFor, acceptInto,
} from '../../../scripts/selfcheck/lib/diff.mjs'
import { normalizeMessage } from '../../../scripts/selfcheck/detectors/error_visibility.mjs'

const det = { id: 'demo' }
type Sev = 'error' | 'warn' | 'info'
const mk = (key: string, severity: Sev = 'warn') => ({ key, severity, title: `t:${key}`, detail: 'd' })

describe('指紋', () => {
  it('検出器 ID と キーの組', () => {
    expect(fingerprint('dead-machinery', 'never-set:candidates.duplicate_flag'))
      .toBe('dead-machinery/never-set:candidates.duplicate_flag')
  })
  it('severity 省略時は warn', () => {
    const [f] = withFingerprints(det, [{ key: 'a', title: 't' } as never])
    expect(f.severity).toBe('warn')
  })
})

describe('指紋の重複', () => {
  it('同じ指紋は落とし、落としたことを隠さない', () => {
    // ⚠ 黙って残すと「1件 accept したら残りも黙る」＝2件目が永久に鳴らない。
    //    reference_errors が初回にこれをやった（同じ型エラーの2か所が同じ指紋）
    const { findings, dupes } = withFingerprintsChecked(det, [mk('same'), mk('same'), mk('other')])
    expect(findings.map((f) => f.fp)).toEqual(['demo/same', 'demo/other'])
    expect(dupes).toEqual(['demo/same'])
  })
  it('重複が無ければ dupes は空', () => {
    expect(withFingerprintsChecked(det, [mk('a'), mk('b')]).dupes).toEqual([])
  })
})

describe('baseline との差分', () => {
  const findings = withFingerprints(det, [mk('a'), mk('b'), mk('c')])

  it('baseline が空なら全部が新規', () => {
    const { fresh, known } = diffAgainstBaseline(findings, {})
    expect(fresh.map((f) => f.fp)).toEqual(['demo/a', 'demo/b', 'demo/c'])
    expect(known).toHaveLength(0)
  })

  it('baseline 済みは新規に出さない（毎晩鳴らないための肝）', () => {
    const { fresh, known } = diffAgainstBaseline(findings, { 'demo/b': { why: '既知', at: '2026-10-03' } })
    expect(fresh.map((f) => f.fp)).toEqual(['demo/a', 'demo/c'])
    expect(known.map((f) => f.fp)).toEqual(['demo/b'])
  })

  it('直った所見は stale として出す（baseline を腐らせない）', () => {
    const { stale } = diffAgainstBaseline(findings, { 'demo/z': { why: 'もう出ない', at: '2026-09-01' } })
    expect(stale).toEqual(['demo/z'])
  })

  it('重い順に並べる（error → warn → info）', () => {
    const mixed = withFingerprints(det, [mk('i', 'info'), mk('e', 'error'), mk('w', 'warn')])
    const { fresh } = diffAgainstBaseline(mixed, {})
    expect(fresh.map((f) => f.severity)).toEqual(['error', 'warn', 'info'])
  })
})

describe('「直したから黙らせた」の解除', () => {
  /**
   * ⚠ ここが無いと、**直した証として baseline に入れた所見が永久に黙る**。
   *    ai_logs のエラー行は控えに残り続けるので指紋は毎晩一致する。
   *    受け入れ時点の最終発生時刻より新しい発生があれば、また鳴らさないといけない。
   */
  const withAt = (key: string, at: string) =>
    withFingerprints(det, [{ ...mk(key), at } as never])

  it('受け入れ後に再発したら、また新規として出す', () => {
    const base = {
      'demo/boom': { why: '直してデプロイ済み', at: '2026-10-03', seenAt: '2026-10-01T06:46:13Z' },
    }
    const { fresh, known } = diffAgainstBaseline(withAt('boom', '2026-10-05T01:00:00Z'), base)
    expect(fresh.map((f) => f.fp)).toEqual(['demo/boom'])
    expect(known).toEqual([])
    expect(fresh[0].recurredSince).toBe('2026-10-01T06:46:13Z')
  })

  it('最終発生が受け入れ時点から進んでいなければ黙ったまま', () => {
    const base = {
      'demo/boom': { why: '直してデプロイ済み', at: '2026-10-03', seenAt: '2026-10-01T06:46:13Z' },
    }
    const { fresh, known } = diffAgainstBaseline(withAt('boom', '2026-10-01T06:46:13Z'), base)
    expect(fresh).toEqual([])
    expect(known.map((f) => f.fp)).toEqual(['demo/boom'])
  })

  it('seenAt を持たない既存の baseline は今までどおり黙る（互換）', () => {
    const base = { 'demo/boom': { why: '意図的', at: '2026-10-03' } }
    const { fresh, known } = diffAgainstBaseline(withAt('boom', '2026-10-09T00:00:00Z'), base)
    expect(fresh).toEqual([])
    expect(known.map((f) => f.fp)).toEqual(['demo/boom'])
  })

  it('受け入れ時に最終発生時刻を seenAt として残す', () => {
    const next = acceptInto({}, withAt('boom', '2026-10-02T05:30:34Z'), '直した', '2026-10-03')
    expect(next['demo/boom'].seenAt).toBe('2026-10-02T05:30:34Z')
  })
})

describe('終了コード', () => {
  it('新規なしは 0', () => expect(exitCodeFor({ fresh: [], crashed: [] })).toBe(0))
  it('新規ありは 1', () => expect(exitCodeFor({ fresh: [mk('a')], crashed: [] })).toBe(1))
  it('検出器が落ちたら 2（所見ゼロより重い）', () => {
    expect(exitCodeFor({ fresh: [], crashed: [{ id: 'x', error: 'boom' }] })).toBe(2)
  })
})

describe('baseline への追記', () => {
  it('理由と日付を残し、既存は上書きしない', () => {
    const base = { 'demo/a': { why: '前の理由', at: '2026-09-01' } }
    const next = acceptInto(base, withFingerprints(det, [mk('a'), mk('b')]), '調査済み', '2026-10-03')
    expect(next['demo/a'].why).toBe('前の理由')
    expect(next['demo/b']).toMatchObject({ why: '調査済み', at: '2026-10-03' })
  })
})

describe('エラー文面の正規化（同じ病気で毎晩鳴らないため）', () => {
  it('件数・UUID・時刻・URL を潰して同じ種類にまとめる', () => {
    const a = normalizeMessage('候補者保存エラー: unsupported Unicode escape sequence (id=3f2b9c10-1111-4222-8333-444455556666)')
    const b = normalizeMessage('候補者保存エラー: unsupported Unicode escape sequence (id=aaaaaaaa-2222-4333-8444-555566667777)')
    expect(a).toBe(b)
  })
  it('長い引用符の中身は潰すが、別の病気は混ぜない', () => {
    expect(normalizeMessage("Cannot access 'attachments' before initialization"))
      .not.toBe(normalizeMessage("Cannot access 'supportedAttachments' before initialization"))
  })
  it('数値だけ違う文面は同じ種類', () => {
    expect(normalizeMessage('Graph添付3件中2件をinboundに渡せず'))
      .toBe(normalizeMessage('Graph添付1件中1件をinboundに渡せず'))
  })
  it('空は空（null を所見にしない）', () => {
    expect(normalizeMessage(null)).toBe('')
    expect(normalizeMessage(undefined)).toBe('')
  })
})
