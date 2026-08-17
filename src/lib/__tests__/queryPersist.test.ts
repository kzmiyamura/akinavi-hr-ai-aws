import { describe, it, expect } from 'vitest'
import {
  PERSIST_DENY_PREFIXES,
  PERSIST_MAX_AGE_MS,
  shouldPersistQuery,
} from '../queryPersist'

/** shouldPersistQuery が見るのは state.status と queryKey[0] だけなので、
 *  テストでは Query 全体ではなくその2つだけを持つ最小の形を渡す */
function q(key: unknown[], status: 'success' | 'error' | 'pending' = 'success', data: unknown = { ok: 1 }) {
  return { queryKey: key, state: { status, data } } as unknown as Parameters<typeof shouldPersistQuery>[0]
}

describe('shouldPersistQuery', () => {
  it('成功した通常のクエリは保存する', () => {
    expect(shouldPersistQuery(q(['candidates-paged', 'prod']))).toBe(true)
    expect(shouldPersistQuery(q(['projects', 'open', 'prod']))).toBe(true)
    expect(shouldPersistQuery(q(['matching-submissions-for-project', 'prod', 'abc', 20]))).toBe(true)
  })

  it('失敗・取得中のクエリは保存しない（復元後にエラー画面が焼き付くため）', () => {
    expect(shouldPersistQuery(q(['candidates-paged', 'prod'], 'error'))).toBe(false)
    expect(shouldPersistQuery(q(['candidates-paged', 'prod'], 'pending'))).toBe(false)
  })

  it('拒否リストのキーは保存しない', () => {
    for (const deny of PERSIST_DENY_PREFIXES) {
      expect(shouldPersistQuery(q([deny, 'x']))).toBe(false)
    }
  })

  it('拒否は先頭要素の完全一致で判定する（前方一致で巻き添えにしない）', () => {
    // 'ai_logs' を拒否しても 'ai_logs_summary' は別キーとして独立に判定される
    expect(PERSIST_DENY_PREFIXES).toContain('ai_logs_summary')
    // 'candidate-raw-profile' を拒否しても 'candidates-paged' は残る
    expect(shouldPersistQuery(q(['candidates-paged', 'prod']))).toBe(true)
    // 拒否リストに無い似た名前は保存される
    expect(shouldPersistQuery(q(['notify_status_history']))).toBe(true)
  })

  it('文字列でないキー先頭は保存しない（想定外の形を localStorage に入れない）', () => {
    expect(shouldPersistQuery(q([{ scope: 'candidates' }]))).toBe(false)
    expect(shouldPersistQuery(q([]))).toBe(false)
  })

  // 2026-08-17 の本番障害: Map を JSON 化して保存 → 復元後は {} になり
  // CandidatePage.tsx:322 の agentDomainMap.get() で「i.get is not a function」。
  // 人材タブが真っ白になった。キー名の列挙だけでは取りこぼすので値の形でも弾く。
  it('Map を返すクエリは保存しない（復元すると .get() が消えるため）', () => {
    expect(shouldPersistQuery(q(['agentDomainMap'], 'success', new Map([['a.co.jp', {}]])))).toBe(false)
    // 名前が違っても Map なら弾く
    expect(shouldPersistQuery(q(['someOtherMap'], 'success', new Map()))).toBe(false)
  })

  it('Set・Date を含むデータも保存しない', () => {
    expect(shouldPersistQuery(q(['x'], 'success', { s: new Set([1]) }))).toBe(false)
    expect(shouldPersistQuery(q(['x'], 'success', { d: new Date(0) }))).toBe(false)
    // 配列の中に潜んでいても見つける
    expect(shouldPersistQuery(q(['x'], 'success', [{ m: new Map() }]))).toBe(false)
  })

  it('ふつうのJSONは保存する', () => {
    expect(shouldPersistQuery(q(['candidates-paged', 'prod'], 'success',
      { pages: [{ candidates: [{ id: '1', name: 'A' }], totalCount: 1 }] }))).toBe(true)
  })

  it('有効期限は60分（2026-08-17 ユーザー判断）', () => {
    expect(PERSIST_MAX_AGE_MS).toBe(1000 * 60 * 60)
  })
})
