/** 「★のみ表示」の端末別設定（2026-08-31 ユーザー要望）
 *
 *  ブックマーク（星）そのものはチーム共有で DB（candidates.bookmarked）に持つが、
 *  「いま★だけを見たいか」は見る人の都合なので端末ごとに持つ。
 *  優先スキルの設定（prioritySkillPref）と同じ考え方・同じ保存方式に揃えてある。
 *
 *  人材タブとマッチングタブで別々に持つ。片方で絞っても、もう片方は影響しない。
 */
const STORAGE_KEY = 'akinavi.bookmarkOnly.v1'

export type BookmarkScope = 'candidates' | 'matching'

type Stored = Partial<Record<BookmarkScope, boolean>>

function read(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {}
  } catch {
    // 壊れた値・localStorage が使えない環境（プライベートウィンドウ等）では既定に倒す
    return {}
  }
}

/** その画面で「★のみ表示」が有効か。既定は false（全人材） */
export function readBookmarkOnly(scope: BookmarkScope): boolean {
  return read()[scope] === true
}

/** 「★のみ表示」を保存する。書けない環境でも例外を投げない */
export function writeBookmarkOnly(scope: BookmarkScope, value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [scope]: value }))
  } catch {
    // 保存できなくても画面は動く（次回開いたときに既定へ戻るだけ）
  }
}
