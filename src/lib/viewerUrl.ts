/**
 * Google Drive ファイルIDを各種URL形式から抽出する
 * - /file/d/{id}/...
 * - ?id={id} or &id={id}  (open?id=, uc?id= など)
 */
function extractDriveFileId(url: string): string | null {
  const byPath = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/)
  if (byPath) return byPath[1]!
  const byParam = url.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (byParam) return byParam[1]!
  return null
}

/**
 * Google Drive / Docs URL を開けるURLに変換する。
 * - drive.google.com の場合: /file/d/{id}/view 形式に正規化（open?id= 等も変換）
 * - docs.google.com (Docs/Sheets/Slides) はそのまま返す
 * - その他: Google Docs Viewer でラップ
 */
export function toViewerUrl(url: string): string {
  if (url.includes('docs.google.com')) {
    return url
  }
  if (url.includes('drive.google.com')) {
    const fileId = extractDriveFileId(url)
    if (fileId) {
      return `https://drive.google.com/file/d/${fileId}/view`
    }
    return url
  }
  return `https://docs.google.com/viewer?url=${encodeURIComponent(url)}`
}
