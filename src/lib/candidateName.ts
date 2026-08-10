/**
 * 氏名の表示ヘルパー。
 *
 * 抽出に失敗した氏名（「オープン系」「昭和３３年５月１３日」「不明」「25_62_IY伊」等）が
 * 一覧の先頭に並ぶと、それだけで製品として信用されない（2026-08-10 ユーザー指摘）。
 * データは消さず、表示だけを中立の文言に置き換える。元の値は title 属性で確認できる。
 *
 * 判定はワーカー側 apply.mjs の isUsableName と同じ考え方。
 * 向こうは「AIの氏名で上書きしてよいか」、こちらは「そのまま画面に出してよいか」で、
 * 目的は違うが弾きたいものは同じ。
 */

/** 氏名として成立しているか */
export function isUsableCandidateName(name: string | null | undefined): boolean {
  const s = String(name ?? '').trim()
  if (!s || s.length > 20) return false
  if (/[0-9０-９]/.test(s)) return false                        // 年齢・生年月日・管理番号の巻き込み
  if (/(昭和|平成|令和|大正)/.test(s)) return false              // 元号＝生年月日
  if (/(オープン系|汎用系|制御系|組込|インフラ|ネットワーク|開発系|運用系)$/.test(s)) return false
  if (/^(不明|未定|なし|該当なし|要員|人材|エンジニア|技術者|氏名|名前|担当者)$/.test(s)) return false
  if (!/[A-Za-zＡ-Ｚａ-ｚぁ-んァ-ヶ一-龥]/.test(s)) return false   // 記号のみ
  return true
}

/** 一覧・詳細に出す氏名。成立していなければ中立の文言を返す */
export function displayCandidateName(name: string | null | undefined): string {
  return isUsableCandidateName(name) ? String(name).trim() : '氏名未取得'
}
