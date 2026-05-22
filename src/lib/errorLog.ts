import { supabase } from './supabase'

interface ErrorLogInput {
  page?: string
  message: string
  stack?: string
  context?: Record<string, unknown>
  dataEnv?: string
  nickname?: string
}

/**
 * エラーを error_logs テーブルに保存する（fire and forget）
 * 保存失敗は握り潰す（エラーログ保存でアプリが止まらないよう）
 */
export function saveErrorLog(input: ErrorLogInput): void {
  supabase
    .from('error_logs')
    .insert({
      page: input.page ?? null,
      message: input.message,
      stack: input.stack ?? null,
      context: input.context ?? null,
      data_env: input.dataEnv ?? null,
      nickname: input.nickname ?? null,
    })
    .then(({ error }) => {
      if (error) console.warn('[errorLog] 保存失敗:', error.message)
    })
}

/** Error オブジェクトから saveErrorLog を呼ぶ便利関数 */
export function logError(
  err: unknown,
  page: string,
  context?: Record<string, unknown>,
  opts?: { dataEnv?: string; nickname?: string },
): void {
  const e = err instanceof Error ? err : new Error(String(err))
  saveErrorLog({
    page,
    message: e.message,
    stack: e.stack,
    context,
    dataEnv: opts?.dataEnv,
    nickname: opts?.nickname,
  })
}
