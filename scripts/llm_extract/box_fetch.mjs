// llm_extract/box_fetch.mjs — Box共有リンク(box.com/s/...)からのファイルダウンロード
// 認証不要の共有ページをスクレイプ: ページHTMLの itemID + 共有名 + cookie で
// 旧来の box_download_shared_file エンドポイントを叩く（2026-08-08 に実リンクで検証済み）。
// ダウンロード許可が無い共有リンクは HTML が返るため失敗として扱う。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** @returns {{buf: Buffer, name: string, mimeType: string}} */
export async function downloadBoxFile(boxUrl) {
  const page = await fetch(boxUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' })
  if (!page.ok) throw new Error(`box page ${page.status}`)
  const html = await page.text()
  const finalUrl = new URL(page.url)
  const cookies = (page.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')

  const idM = html.match(/"itemID"\s*:\s*"?(\d+)"?/)
  const shM = finalUrl.pathname.match(/\/s\/([A-Za-z0-9]+)/) || String(boxUrl).match(/\/s\/([A-Za-z0-9]+)/)
  if (!idM || !shM) throw new Error('box page parse failed (itemID/shared_name)')

  const dlUrl = `${finalUrl.origin}/index.php?rm=box_download_shared_file&shared_name=${shM[1]}&file_id=f_${idM[1]}`
  const res = await fetch(dlUrl, {
    headers: { 'User-Agent': UA, Cookie: cookies, Referer: page.url },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`box download ${res.status}`)
  const mimeType = res.headers.get('content-type') || 'application/octet-stream'
  if (/text\/html/i.test(mimeType)) throw new Error('box download returned html（共有リンクのDL許可なし?）')

  let name = null
  const cd = res.headers.get('content-disposition') || ''
  const fnStar = cd.match(/filename\*=UTF-8''([^;]+)/i)
  const fn = cd.match(/filename="?([^";]+)"?/i)
  if (fnStar) name = decodeURIComponent(fnStar[1])
  else if (fn) name = fn[1]
  if (!name) {
    const nm = html.match(/"itemName"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    name = nm ? JSON.parse(`"${nm[1]}"`) : `box_${idM[1]}`
  }
  return { buf: Buffer.from(await res.arrayBuffer()), name, mimeType }
}
