import { useState } from 'react'
import { Star } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { setBookmark } from '../lib/db/candidates'
import { patchCandidateEverywhere } from '../lib/candidateCache'
import type { DataEnv } from '../lib/dataEnv'

interface Props {
  candidateId: string
  dataEnv: DataEnv
  bookmarked: boolean
  /** 一覧の行に置くときは sm、詳細のヘッダは md */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 人材のブックマーク（星）。チーム共有の1状態で、押すと即座に反転する。
 *
 * 押すたびに一覧を取り直すと100件ぶん（約100KB）が飛ぶので、
 * 通信は UPDATE 1行だけにして、画面は手元のキャッシュを書き換えて反映する。
 * 失敗したら見た目を元に戻す（楽観更新）。
 *
 * 競合は後勝ち。星の付け外しが同時に走っても実害が無いため排他制御はしない。
 */
export function BookmarkStar({ candidateId, dataEnv, bookmarked, size = 'sm', className = '' }: Props) {
  const queryClient = useQueryClient()
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const on = optimistic ?? bookmarked
  const px = size === 'md' ? 18 : 15

  async function toggle(e: React.MouseEvent) {
    // 一覧の行ごとクリック（詳細を開く）に反応させない
    e.stopPropagation()
    e.preventDefault()
    if (busy) return
    const next = !on
    setOptimistic(next)
    setBusy(true)
    try {
      await setBookmark(candidateId, dataEnv, next)
      // 一覧・詳細のキャッシュだけ書き換える（再取得しない）
      patchCandidateEverywhere(queryClient, candidateId, { bookmarked: next })
    } catch {
      setOptimistic(!next) // 失敗したら見た目を戻す
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
      title={on ? 'ブックマークを外す' : 'ブックマークする'}
      className={`shrink-0 rounded p-1 transition-colors disabled:opacity-50 ${
        on ? 'text-amber-500 hover:text-amber-600' : 'text-gray-300 hover:text-amber-400'
      } ${className}`}
    >
      <Star size={px} fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}
