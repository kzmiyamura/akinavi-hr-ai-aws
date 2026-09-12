/** vite.config.ts の define で注入されるビルドID。
 *  永続キャッシュの buster に使う（デプロイのたびに変わる）。
 *  vitest 実行時は define が効かないため、参照側で typeof チェックすること。
 *
 *  `declare global` で囲む理由: tsconfig の moduleDetection が "force" なので、
 *  裸の `declare const` はこのファイルの中だけの宣言になり、**グローバルにならない**。
 *  2026-09-12 まで `tsc --noEmit` が1ファイルも見ていなかったため気づけなかった。
 */
export {}

declare global {
  const __APP_BUILD_ID__: string
}
