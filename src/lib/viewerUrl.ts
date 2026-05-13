/**
 * Google Drive / Docs URL はそのまま返す（ブラウザで直接表示可能）
 * Supabase Storage 等のその他URLはGoogle Docs Viewerで表示できるよう変換する
 */
export function toViewerUrl(url: string): string {
  if (
    url.includes('drive.google.com') ||
    url.includes('docs.google.com')
  ) {
    return url
  }
  return `https://docs.google.com/viewer?url=${encodeURIComponent(url)}`
}
