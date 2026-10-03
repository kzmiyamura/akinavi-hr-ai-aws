/**
 * 人材一覧の取得が「件数の全行スキャン」を待たないこと。
 *
 * ⚠ 2026-10-03「人材タブ開いた最初読み込み中が遅くて重い」の再発防止。
 *
 *   一覧の1ページ目に `count: 'exact'` を相乗りさせていた。
 *   優先スキル絞り込みは `skills.cs.`（GIN索引あり）と
 *   `raw_profile->>text.imatch`（索引が効かない）を**OR で繋ぐ**ので索引が使えず、
 *   `count: 'exact'` は述語を**全行に評価する**ため prod 8,222 行の本文
 *   （1件13〜35KB）に正規表現が走る。**一覧が1行も描けないままそれを待っていた。**
 *
 *   件数は後から出てよい情報なので別クエリに切り出した。
 *   ここが戻ると体感が落ちるので、取得の形を固定する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Recorded { table: string; select: [string, unknown]; filters: string[] }
const recorded: Recorded[] = []
let result: { data: unknown; error: unknown; count: number | null } = { data: [], error: null, count: null }

/** supabase-js のチェーンを記録するだけのダミー */
function makeChain(table: string) {
  const rec: Recorded = { table, select: ['', undefined], filters: [] }
  recorded.push(rec)
  const chain: Record<string, unknown> = {}
  const passthrough = (name: string) => (...args: unknown[]) => {
    rec.filters.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`)
    return chain
  }
  for (const m of ['eq', 'is', 'or', 'order', 'gte', 'lte', 'in', 'not']) chain[m] = passthrough(m)
  chain.select = (cols: string, opts: unknown) => {
    rec.select = [cols, opts]
    return chain
  }
  // range で解決する（fetchCandidatesPage は range が終端）
  chain.range = (...args: unknown[]) => {
    rec.filters.push(`range(${args.join(',')})`)
    return Promise.resolve(result)
  }
  // head:true の count 系は select/filters の後に await される
  chain.then = (onOk: (v: unknown) => unknown) => Promise.resolve(result).then(onOk)
  return chain
}

vi.mock('../../supabase', () => ({
  supabase: { from: (t: string) => makeChain(t) },
}))

const { fetchCandidatesPage, fetchPriorityCandidateCount } = await import('../candidates')

const SKILLS = ['Java', 'C#']

beforeEach(() => {
  recorded.length = 0
  result = { data: [], error: null, count: null }
})

describe('fetchCandidatesPage', () => {
  it('1ページ目でも件数を要求しない（全行スキャンを待たない）', async () => {
    await fetchCandidatesPage('prod', 0, 100, SKILLS)
    const [, opts] = recorded[0].select
    expect(opts).toEqual({})
    expect(JSON.stringify(opts)).not.toContain('exact')
  })

  it('2ページ目以降も同じ（挙動がページで分岐しない）', async () => {
    await fetchCandidatesPage('prod', 100, 100, SKILLS)
    expect(recorded[0].select[1]).toEqual({})
  })

  it('totalCount は返さない（件数は別クエリの担当）', async () => {
    result = { data: [], error: null, count: 4321 }
    const r = await fetchCandidatesPage('prod', 0, 100, SKILLS)
    expect(r.totalCount).toBeNull()
  })

  it('本文を丸ごと引かない（raw_profile は必要なキーだけ）', async () => {
    await fetchCandidatesPage('prod', 0, 100, SKILLS)
    const [cols] = recorded[0].select as [string, unknown]
    expect(cols).not.toMatch(/(^|,)\s*raw_profile\s*(,|$)/)
    expect(cols).toContain('raw_profile->>_llm_checked_at')
  })

  it('優先スキルがあるときだけ or() を付ける', async () => {
    await fetchCandidatesPage('prod', 0, 100, SKILLS)
    expect(recorded[0].filters.some((f) => f.startsWith('or('))).toBe(true)

    recorded.length = 0
    await fetchCandidatesPage('prod', 0, 100, null)
    expect(recorded[0].filters.some((f) => f.startsWith('or('))).toBe(false)
  })
})

describe('fetchPriorityCandidateCount', () => {
  it('件数だけを数え、本体は受け取らない（head: true）', async () => {
    result = { data: null, error: null, count: 6186 }
    const n = await fetchPriorityCandidateCount('prod', SKILLS)
    expect(n).toBe(6186)
    expect(recorded[0].select[1]).toMatchObject({ count: 'exact', head: true })
    expect(recorded[0].select[0]).toBe('id')
  })

  it('一覧と同じ絞り込みを掛ける（件数と中身が食い違わないように）', async () => {
    result = { data: null, error: null, count: 1 }
    await fetchPriorityCandidateCount('prod', SKILLS, true)
    const f = recorded[0].filters.join(' ')
    expect(f).toContain('or(')
    expect(f).toContain('bookmarked')
    expect(f).toContain('merged_into')
  })

  it('優先スキルが無ければ or() を付けない（索引だけで数えられる）', async () => {
    result = { data: null, error: null, count: 8222 }
    await fetchPriorityCandidateCount('prod', null)
    expect(recorded[0].filters.some((x) => x.startsWith('or('))).toBe(false)
  })
})
