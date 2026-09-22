/**
 * 添付（経歴書）解析の再利用判定 — `shouldReuseAttachment`。
 *
 * 背景（2026-09-22 実測）:
 * 常駐ワーカーのログ 5,093 サイクルを数えたところ、
 *   添付解析 2,974回 のうち 1,236回(41.6%) が「同じ人材の2回目以降」
 *   うち 602回 は前回と1文字も違わない結果（proj数・cov・est/got が完全一致）
 * だった。実例 H.K は 27回 処理され、毎回 proj=18 / est/got=18/18。
 * 取引先が同じ人材を再送 → raw_profile が差し替わり印が消える → 再入、という
 * 設計どおりの流れの中で、**一番重い処理だけが無駄にやり直されていた**。
 *
 * この判定は「読み取り結果を古いまま焼き付ける」危険と隣り合わせなので、
 * 迷ったら必ず「解析し直す」側に倒れることをここで固定する。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error — 常駐ワーカーの共有ライブラリ（JS・型定義なし）
import { shouldReuseAttachment } from '../../../scripts/llm_extract/shadow_worker_lib.mjs'

const V = '2026-09-22'
const URL_A = 'https://x.supabase.co/storage/v1/object/public/attachments/resumes/YN_a1b2c3d4e5f6a1b2c3d4.xlsx'
const URL_B = 'https://x.supabase.co/storage/v1/object/public/attachments/resumes/YN_ffffffffffffffffffff.xlsx'

/** 正常に解析できた llm_shadow の行 */
const okRow = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  model: 'haiku',
  projects: [{ title: 'A' }, { title: 'B' }],
  skill_years: { Java: 36 },
  source_url: URL_A,
  extractor_version: V,
  ...over,
})

describe('経歴書の再解析を省いてよいか', () => {
  it('同じファイル・同じ抽出器なら再利用する', () => {
    expect(shouldReuseAttachment(okRow(), URL_A, V)).toBe(true)
  })

  it('ファイルが差し替わったら解析し直す', () => {
    // ファイル名に内容のSHA-256が入るので、URLが違う＝中身が違う
    expect(shouldReuseAttachment(okRow(), URL_B, V)).toBe(false)
  })

  it('抽出器を直したら解析し直す（改善が既存人材に届かなくなるため）', () => {
    expect(shouldReuseAttachment(okRow(), URL_A, '2026-10-01')).toBe(false)
    expect(shouldReuseAttachment(okRow({ extractor_version: null }), URL_A, V)).toBe(false)
  })

  it('前回が失敗なら必ず再試行する（失敗を固定しない）', () => {
    expect(shouldReuseAttachment(okRow({ status: 'error', projects: null }), URL_A, V)).toBe(false)
  })

  it('案件が1件も取れていない結果は焼き付けない', () => {
    expect(shouldReuseAttachment(okRow({ projects: [] }), URL_A, V)).toBe(false)
    expect(shouldReuseAttachment(okRow({ projects: null }), URL_A, V)).toBe(false)
  })

  it('要確認(needs_review)でも案件が取れていれば再利用する', () => {
    // needs_review は「程度問題」ではなく「結果が使えない」時だけ付く印だが、
    // 案件が取れている以上、同じファイルを解析し直しても同じ印が付くだけ
    expect(shouldReuseAttachment(okRow({ status: 'needs_review' }), URL_A, V)).toBe(true)
  })

  it('記録が無い・URLが無いときは解析する', () => {
    expect(shouldReuseAttachment(null, URL_A, V)).toBe(false)
    expect(shouldReuseAttachment(undefined, URL_A, V)).toBe(false)
    expect(shouldReuseAttachment(okRow(), null, V)).toBe(false)
    expect(shouldReuseAttachment(okRow(), '', V)).toBe(false)
  })

  it('過去に保存した行（source_url を持たない）は再利用しない', () => {
    // 列を足す前の行は source_url が null。null 同士で一致したことにしてはいけない
    expect(shouldReuseAttachment(okRow({ source_url: null }), URL_A, V)).toBe(false)
    expect(shouldReuseAttachment(okRow({ source_url: null }), null, V)).toBe(false)
  })
})
