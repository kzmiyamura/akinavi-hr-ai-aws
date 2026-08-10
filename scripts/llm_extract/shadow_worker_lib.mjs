// shadow_worker_lib.mjs — shadow_worker.mjs の純粋関数（テスト用に env なしで読める場所へ切り出し）
//
// shadow_worker.mjs は起動時に SUPABASE_URL 等を要求するため、
// 単体テストから読めるようロジックだけをここに置き、worker からは import して使う。

/**
 * LLM に渡す本文を絞る。署名・法務定型文・URL は抽出に使わないのに毎回トークンを食う
 * （本文1件 $0.032・入力13,000tok に対し本文自体は4,000tok 程度だった・2026-08-10）。
 * 人物情報は本文前半にあるため、定型文以降は落として上限も下げる。
 */
export function trimBodyForLlm(text) {
  let t = String(text ?? '')
  // 署名・定型文の開始位置で打ち切る（最初に現れたもの）。
  // 300字より手前は本文の飾り罫線の可能性があるため対象外にする
  const CUT = [
    /^[-－—ー=＝*＊_]{8,}$/m, /配信停止/, /本メールは.{0,10}送信/, /個人情報の取扱/,
    /秘密保持/, /【重要：要員情報の利用範囲/, /このメールは、宛先として/, /免責事項/,
  ]
  let cut = t.length
  for (const re of CUT) {
    const m = t.match(re)
    if (m && m.index != null && m.index > 300 && m.index < cut) cut = m.index
  }
  t = t.slice(0, cut)
  t = t.replace(/https?:\/\/\S+/g, '(URL)')      // URLは判断に使わない
  return t.slice(0, 6000)
}
