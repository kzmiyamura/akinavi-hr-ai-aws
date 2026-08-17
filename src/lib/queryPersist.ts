/** TanStack Query の永続キャッシュ設定（2026-08-17）
 *
 *  背景: QueryClient がメモリのみだったため、営業がタブを開き直す・F5 するたびに
 *  一覧をまるごと引き直していた。Supabase Free Plan の egress は 5GB/月で、
 *  8/13 は単日 822MB（うち 94% が PostgREST）を出している。営業5人運用に耐えないため
 *  localStorage に載せてリロード時の再取得をゼロにする。
 *
 *  持たせない方針:
 *   - 60分（gcTime と同じ）を過ぎたら丸ごと破棄して取り直す
 *   - デプロイのたびに buster が変わり、古い形のデータを復元しない
 *   - 一時的・巨大・意味の無いものは除外（下記 PERSIST_DENY_PREFIXES）
 */
import type { Query } from '@tanstack/react-query'

/** localStorage のキー。変更すると旧キャッシュは孤児になるので消して回る必要がある */
export const PERSIST_KEY = 'akinavi-query-cache'

/** 有効期限。これを過ぎた復元データは丸ごと捨てられる（2026-08-17 ユーザー判断で60分） */
export const PERSIST_MAX_AGE_MS = 1000 * 60 * 60

/** 永続化しないクエリキーの先頭要素。実在するキーだけを列挙している（2026-08-17 に全 queryKey を確認）。
 *
 *  容量を食うもの:
 *   - 'candidate-raw-profile' … 1件35KB。詳細を開いた人材ぶん積み上がる（CandidatePage.tsx:1234）
 *   - 'ai_logs' / 'ai_logs_summary' … 監視画面のログ。件数が多いうえ鮮度が要る
 *
 *  古い値を復元すると誤解を生むもの:
 *   - 'connectionStatuses' … Microsoft 連携の生死。切れているのに「接続済み」と出ては困る
 *   - 'emailSettings' … メール取り込み設定
 *   - 'box-fetch-poll' / 'importActive' … 進行状況のポーリング。復元しても意味が無い
 *   - 'notify_status' … 通知の実行状況
 *   - 'ghIssues' … GitHub Issue 一覧（外部API・鮮度が要る）
 */
export const PERSIST_DENY_PREFIXES = [
  'candidate-raw-profile',
  'ai_logs',
  'ai_logs_summary',
  'connectionStatuses',
  'emailSettings',
  'box-fetch-poll',
  'importActive',
  'notify_status',
  'ghIssues',
  // Map を返すクエリ。値の形でも弾いているが、意図を明示するため名前でも落とす
  // （2026-08-17 の本番障害の当事者。CandidatePage / MatchingPage が .get() を呼ぶ）
  'agentDomainMap',
] as const

/** JSON にすると別物になってしまう値か。
 *
 *  Map / Set は JSON.stringify で `{}` になり、復元後に `.get is not a function` で
 *  画面が落ちる。2026-08-17 に本番の人材タブがこれで壊れた
 *  （`agentDomainMap` は Map。CandidatePage.tsx:322 が `.get()` を呼ぶ）。
 *  キー名の列挙では取りこぼすので、値の形で機械的に弾く。
 */
function isJsonUnsafe(value: unknown, depth = 0): boolean {
  if (value == null || depth > 3) return false
  if (value instanceof Map || value instanceof Set || value instanceof Date) return true
  if (Array.isArray(value)) return value.slice(0, 20).some((v) => isJsonUnsafe(v, depth + 1))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .slice(0, 50)
      .some((v) => isJsonUnsafe(v, depth + 1))
  }
  return false
}

/** このクエリを localStorage に載せるか。
 *  成功したものだけを対象にし、拒否リストの接頭辞と
 *  JSON 化で壊れる値（Map/Set 等）は落とす。
 *  （エラー・取得中を載せると、復元後にエラー画面が焼き付く）
 */
export function shouldPersistQuery(query: Pick<Query, 'state' | 'queryKey'>): boolean {
  if (query.state.status !== 'success') return false
  const head = query.queryKey?.[0]
  if (typeof head !== 'string') return false
  if (PERSIST_DENY_PREFIXES.some((deny) => head === deny)) return false
  return !isJsonUnsafe(query.state.data)
}

/** ビルドごとに変わる文字列。デプロイすると復元されなくなる（形の変わったデータを描画しないため）。
 *  vite.config.ts の define で注入する。開発時は 'dev'。
 */
export function persistBuster(): string {
  return typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'dev'
}
