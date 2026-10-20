/**
 * クリップボードへのコピー。**成功したかどうかを必ず返す**。
 *
 * `navigator.clipboard` は使えないことがある:
 *   - https でないとき（`localhost` 以外の社内 IP で開いた場合など）は API ごと無い
 *   - iOS の WebView・PWA では権限を落とすことがある（例外が飛ぶ）
 * どちらも「押したのに何も起きない」になるので、
 * 旧 API（`document.execCommand('copy')`）まで試し、**それでも駄目なら false を返す**。
 * 呼び出し側は false のときに URL を画面に出して手でコピーさせること
 * （黙って成功したように見せない）。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 権限拒否・非セキュアコンテキスト。下の方法を試す
  }
  try {
    // 画面に出さずに選択してコピーする。`position: fixed` にしておかないと
    // 長い文字列で画面が一瞬スクロールする
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    // iOS Safari は select() だけでは範囲が付かない
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
