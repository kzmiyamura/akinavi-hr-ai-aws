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

/**
 * 人材が出てくる**あらゆる**キャッシュを部分更新する。
 *
 * ブックマーク（星）は一覧・詳細・マッチング・人材マップのどこからでも押せるので、
 * 押した場所以外の表示も同時に更新しないと、タブを切り替えたときに古い状態が見える。
 * かといって invalidate すると一覧の再取得（約100KB/ページ）が走る。
 *
 * そこでキャッシュを走査し、「Candidate の配列」または「{pages:[{candidates:[]}]}」
 * または「Candidate 単体」の形をしていれば、該当 id だけを差し替える。
 * 形が違うキャッシュ（案件・提案履歴など）はそのまま返すので影響しない。
 */
export function patchCandidateEverywhere(
  queryClient: QueryClient,
  id: string,
  patch: Partial<Candidate>,
): void {
  const isCandidate = (v: unknown): v is Candidate =>
    !!v && typeof v === 'object' && 'id' in (v as Record<string, unknown>)
      && 'skills' in (v as Record<string, unknown>)

  queryClient.setQueriesData({ predicate: () => true }, (old: unknown) => {
    if (!old) return old

    // ① 無限スクロールの一覧 { pages: [{ candidates: [...] }] }
    const paged = old as PagedCache
    if (paged?.pages?.length && Array.isArray(paged.pages[0]?.candidates)) {
      let hit = false
      const pages = paged.pages.map((p) => ({
        ...p,
        candidates: p.candidates.map((c) => {
          if (c.id !== id) return c
          hit = true
          return { ...c, ...patch }
        }),
      }))
      return hit ? { ...paged, pages } : old
    }

    // ② 人材の配列
    if (Array.isArray(old) && old.length > 0 && isCandidate(old[0])) {
      let hit = false
      const next = (old as Candidate[]).map((c) => {
        if (c.id !== id) return c
        hit = true
        return { ...c, ...patch }
      })
      return hit ? next : old
    }

    // ③ 人材1件（詳細画面）
    if (isCandidate(old) && (old as Candidate).id === id) {
      return { ...(old as Candidate), ...patch }
    }

    return old
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
