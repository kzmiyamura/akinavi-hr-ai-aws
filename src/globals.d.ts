/** vite.config.ts の define で注入されるビルドID。
 *  永続キャッシュの buster に使う（デプロイのたびに変わる）。
 *  vitest 実行時は define が効かないため、参照側で typeof チェックすること。
 */
declare const __APP_BUILD_ID__: string
