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
 * - supabase.co/storage の場合: 直接ダウンロードURLとしてそのまま返す
 * - その他: Google Docs Viewer でラップ
 */
/** 受信添付の実体（raw/）の保持日数。cleanup-storage の raw_retention_days と揃える。
 *  名簿メールの参照リンクはここを過ぎると消えるので、画面はリンクを出さず理由を表示する。 */
export const RAW_ATTACHMENT_RETENTION_DAYS = 1

/** 名簿メールの参照リンクがまだ生きているか（登録日時から判定） */
export function isRosterLinkAlive(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false
  const ms = Date.now() - new Date(createdAt).getTime()
  return Number.isFinite(ms) && ms < RAW_ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
}

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
  // Supabase Storage URL: Office形式は Microsoft Office Online で開く
  if (url.includes('supabase.co/storage')) {
    const lower = url.toLowerCase().split('?')[0]
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.docx') || lower.endsWith('.doc')) {
      return `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(url)}`
    }
    // PDF・画像はブラウザが直接開けるのでそのまま返す
    return url
  }
  return `https://docs.google.com/viewer?url=${encodeURIComponent(url)}`
}
