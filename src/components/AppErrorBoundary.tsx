import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { isChunkLoadError } from '../lib/lazyPage'
import { logError } from '../lib/errorLog'

interface Props {
  children: ReactNode
  /** どの枠で落ちたか。error_logs の page に入る */
  label: string
  /** 再読み込みせずに抜けられる枠だけ渡す（詳細画面の「一覧に戻る」） */
  onLeave?: () => void
  leaveLabel?: string
  /** これが変わったらエラー状態を解除する（別の人材を開き直したとき） */
  resetKey?: string
  dataEnv?: string
  nickname?: string
}

/**
 * 画面を白紙（iOS では theme_color の青一色）にしないための境界。
 *
 * 2026-10-20 営業から「人材マップから人材を選ぶと青くなる時がある」。
 * 画面が青いのは**何も描かれていない**から（manifest の theme_color #2563eb で
 * iOS Safari が塗る）。原因は、遅延読み込みしているページの読み込みが失敗したとき、
 * **人材詳細・案件詳細だけ境界の外にあって例外がルートまで抜け、React が
 * アプリ全体を外していた**こと。ヘッダーもタブごと消えるので、営業からは
 * 「固まった」ようにしか見えず、戻る手段も無い。
 *
 * ⚠ **error_logs に何も残っていなかった**（直近は 2026-06-23・実測）。
 *   境界が無い＝記録も無いので、再発しても原因を特定できない。ここで必ず記録する。
 *
 * 失敗の種類で直し方が違うので文面を分ける:
 *   - チャンクの読み込み失敗 … 配信が入れ替わったか通信が切れている（再読み込みで直る）
 *   - それ以外              … 不具合。記録を見て直す
 */
export class AppErrorBoundary extends Component<Props, { error: Error | null }> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 同じセッションで同じ所が何度も落ちても1回だけ送る（error_logs を溢れさせない）
    const key = `${this.props.label}:${error.message}`
    if (loggedOnce.has(key)) return
    loggedOnce.add(key)
    logError(error, this.props.label, {
      chunkLoad: isChunkLoadError(error),
      url: window.location.href,
      online: navigator.onLine,
      // 全部入れると1件が大きくなるので先頭だけ（落ちた部品名は先頭に出る）
      componentStack: (info.componentStack ?? '').slice(0, 1000),
    }, { dataEnv: this.props.dataEnv, nickname: this.props.nickname })
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const isChunk = isChunkLoadError(error)
    return (
      <div className="flex flex-col items-center justify-center p-10 gap-4 text-center">
        <p className="text-red-600 font-medium">ページの読み込みに失敗しました</p>
        {isChunk ? (
          <p className="text-sm text-gray-600 max-w-sm">
            アプリが更新されたか、通信が切れています。
            少し待ってから再読み込みしてください。
          </p>
        ) : (
          <p className="text-sm text-gray-600 max-w-sm">
            不具合です。記録を残したので、このまま他の画面は使えます。
          </p>
        )}
        <p className="text-xs text-gray-400 max-w-sm break-all">{error.message}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* 通信が切れていても押せる方を先に出す（再読み込みは失敗しうる） */}
          {this.props.onLeave && (
            <button
              type="button"
              onClick={() => { this.setState({ error: null }); this.props.onLeave?.() }}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              {this.props.leaveLabel ?? '一覧に戻る'}
            </button>
          )}
          <button
            type="button"
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            className={`px-4 py-2 text-sm rounded-lg ${
              this.props.onLeave
                ? 'border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            再読み込み
          </button>
        </div>
      </div>
    )
  }
}

/** 送信済みの「枠 × 文面」。同じ不具合で error_logs を埋めない */
const loggedOnce = new Set<string>()

/** テスト用。セッションをまたいだ重複抑止の状態を消す */
export function __resetErrorLogDedupe() {
  loggedOnce.clear()
}
