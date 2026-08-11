import type { QueryClient } from '@tanstack/react-query'
import type { Candidate } from './db/candidates'
import type { DataEnv } from './dataEnv'

/**
 * 人材一覧キャッシュの部分更新。
 *
 * 一覧は useInfiniteQuery で、invalidateQueries を呼ぶと**保持中の全ページ**を
 * 取り直す。1ページ約131KB・最大5ページなので、1人の変更のたびに約650KBが飛ぶ。
 * 2026-08-11 の実測では Supabase egress の 91.6% が PostgREST（＝DB読み取り）で、
 * 一覧の再取得がその主因だった。
 *
 * 「人が増減する」変更（新規登録・再解析）は一覧の構成が変わるので invalidate が正しい。
 * 「1人の値が変わるだけ」の変更はここで差し替える。
 */

type PagedCache = { pages?: { candidates: Candidate[] }[] } | undefined

const pagedKey = (dataEnv: DataEnv) => ({ queryKey: ['candidates-paged', dataEnv] })

/** 一覧キャッシュ内の1人だけを部分更新する */
export function patchCandidateInCache(
  queryClient: QueryClient,
  dataEnv: DataEnv,
  id: string,
  patch: Partial<Candidate>,
): void {
  queryClient.setQueriesData(pagedKey(dataEnv), (old: unknown) => {
    const cache = old as PagedCache
    if (!cache?.pages) return old
    return {
      ...cache,
      pages: cache.pages.map((p) => ({
        ...p,
        candidates: p.candidates.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),
    }
  })
}

/** 一覧キャッシュから1人を取り除く（削除時）。
 *  totalCount は持っていれば1件減らして表示のズレを防ぐ */
export function removeCandidateFromCache(
  queryClient: QueryClient,
  dataEnv: DataEnv,
  id: string,
): void {
  queryClient.setQueriesData(pagedKey(dataEnv), (old: unknown) => {
    const cache = old as { pages?: { candidates: Candidate[]; totalCount?: number | null }[] } | undefined
    if (!cache?.pages) return old
    return {
      ...cache,
      pages: cache.pages.map((p) => ({
        ...p,
        candidates: p.candidates.filter((c) => c.id !== id),
        totalCount: typeof p.totalCount === 'number' ? Math.max(0, p.totalCount - 1) : p.totalCount,
      })),
    }
  })
}
