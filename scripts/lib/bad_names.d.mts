/**
 * bad_names.mjs の型。テスト（src/lib/__tests__/badNameReasons.test.ts）から import するため。
 * ⚠ `vercel.json` の buildCommand は `tsc -b && vite build` なので、
 *    型が付いていないと**フロントのデプロイが落ちる**。
 */

/** 氏名として成立しない理由。空配列なら問題なし */
export function badNameReasons(name: unknown): string[]
