import { useEffect, useRef, useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { candidateLinkUrl } from '../lib/candidateCode'
import { copyTextToClipboard } from '../lib/copyToClipboard'
import type { DataEnv } from '../lib/dataEnv'

interface Props {
  candidateId: string
  dataEnv: DataEnv
  /** 一覧寄りのツールバーは sm、詳細画面のヘッダは md */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * この人を直接開く URL をコピーするボタン（2026-10-20 営業の要望
 * 「アプリで一発で開ける url をクリップボードにコピーできるボタン。人材詳細の全部の箇所に」）。
 *
 * 通知メールのリンクと**同じ形**（`?c=<uuid>`）を同じ関数 `candidateLinkUrl` で作る。
 * 受け取った側の処理は App.tsx に既にあり、`data_env` も行に合わせて切り替わるので、
 * ここで付けるのは uuid だけでよい。
 *
 * ⚠ **氏名・メールアドレス・人材番号を URL に入れない。**
 *   貼り先（チャット・メール・プロキシ）に URL ごと残る。uuid なら誰かは分からない。
 *   人材番号は保持期間を過ぎた再登録で変わる（実測で約2%）ので、リンクには使わない。
 *
 * 宛先は `app_config.app_base_url` ではなく**今開いている画面の origin**。
 * 社内の別 URL で開いている人がコピーしても、その人が開けた URL のまま渡せる。
 */
export function CopyCandidateLinkButton({ candidateId, dataEnv, size = 'sm', className = '' }: Props) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const url = candidateLinkUrl(window.location.origin, candidateId)

  // 別の人材を開いたらボタンの表示を戻す（前の「コピーしました」が残らないように）
  useEffect(() => {
    setState('idle')
  }, [candidateId])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  async function handleCopy(e: React.MouseEvent) {
    // 行ごとクリックで詳細が開く画面があるので、親に伝えない
    e.stopPropagation()
    e.preventDefault()
    const ok = await copyTextToClipboard(url)
    setState(ok ? 'done' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    // 失敗表示は消さない（URL を手でコピーしてもらうため）
    if (ok) timer.current = setTimeout(() => setState('idle'), 2000)
  }

  const pad = size === 'md' ? 'px-3 sm:px-4 py-2 text-xs sm:text-sm' : 'px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm'
  const px = size === 'md' ? 15 : 14
  const done = state === 'done'

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className={`inline-flex items-center gap-1.5 sm:gap-2 border rounded-lg transition-colors ${pad} ${
          done
            ? 'border-green-300 text-green-700 bg-green-50'
            : 'border-gray-200 text-gray-600 hover:text-blue-600 hover:border-blue-300'
        } ${className}`}
        title={[
          'この人を直接開く URL をコピーします（メール・チャットに貼れます）。',
          '氏名は URL に入りません。',
          dataEnv === 'demo'
            ? '⚠ デモの人材なので、デモ表示を解除していない端末では開けません。'
            : '⚠ 人材は7日で消えます。消えた後はこの URL でも開けません。',
        ].join('\n')}
      >
        {done ? <Check size={px} /> : <Link2 size={px} />}
        {done ? 'コピーしました' : 'URLをコピー'}
      </button>
      {state === 'failed' && (
        // 「押したのに何も起きない」を出さない。この端末ではコピーできないので、
        // URL をそのまま出して選べるようにする（触るだけで全選択される）
        <input
          type="text"
          readOnly
          value={url}
          aria-label="この人を開く URL（手でコピーしてください）"
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => { e.stopPropagation(); e.currentTarget.select() }}
          className="w-full sm:w-72 text-xs font-mono text-gray-700 bg-amber-50 border border-amber-300 rounded-lg px-2 py-1.5"
          title="この端末では自動コピーができませんでした（https でないか、ブラウザが拒否しました）。ここを選んでコピーしてください"
        />
      )}
    </>
  )
}
