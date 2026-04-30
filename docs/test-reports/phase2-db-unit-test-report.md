# 単体テスト項目書 兼 結果報告書
## Phase 2: DB 保存ロジック（candidates / submissions）

- **実施日**: 2026-04-30
- **実施者**: Claude Code (claude-sonnet-4-6)
- **テストフレームワーク**: Vitest v4.1.5
- **対象ファイル**: `src/lib/db/`

---

## テスト結果サマリー

| 項目 | 件数 |
|---|---|
| テストファイル | 2 |
| テスト総数 | 8 |
| **合格** | **8** |
| 失敗 | 0 |
| 実行時間 | 約 1.6 秒（AI テスト 9件と合計 17件） |

---

## テスト項目一覧

### upsertCandidate（人材登録・更新）

| # | テストケース | 確認内容 | 結果 |
|---|---|---|---|
| 1 | email あり: upsert を呼び出し結果を返す | email が存在する場合、Supabase の upsert（onConflict: email）が呼ばれること | ✅ PASS |
| 2 | email あり: 同一メールの既存レコードを上書き更新する | 同一 email のレコードが更新されること（email重複→自動UPDATE 要件） | ✅ PASS |
| 3 | email なし: insert を呼び出す | email が null の場合は upsert でなく insert が呼ばれること | ✅ PASS |
| 4 | duplicateSuspected=true のとき duplicate_flag=true で保存される | AI の重複疑いフラグが DB に正しく保存されること | ✅ PASS |
| 5 | Supabase がエラーを返したとき例外をスローする | DB エラー時に意味のあるエラーメッセージで例外が発生すること | ✅ PASS |

### upsertSubmission（マッチング結果保存）

| # | テストケース | 確認内容 | 結果 |
|---|---|---|---|
| 6 | マッチング結果を正しく保存し submission を返す | match_score / ai_summary / status が正しく保存されること | ✅ PASS |
| 7 | 同一ペア(candidate_id, project_id)は上書き保存される | 重複提案防止（UNIQUE制約）に対応した upsert が動作すること | ✅ PASS |
| 8 | Supabase がエラーを返したとき例外をスローする | DB エラー時に意味のあるエラーメッセージで例外が発生すること | ✅ PASS |

---

## テスト設計のポイント

- **Supabase クライアントをモック**: 実 DB に接続せず、チェーンメソッド（`from → upsert/insert → select → single`）を vi.fn() で再現
- **email 重複→自動UPDATE の確認 (No.1, 2)**: `onConflict: 'email'` オプションが必ず渡されることを `toHaveBeenCalledWith` で検証
- **email なし分岐の確認 (No.3)**: email=null 時に insert が呼ばれ upsert が呼ばれないことを確認
- **duplicate_flag 連携 (No.4)**: AI の `duplicateSuspected` フラグが DB ペイロードの `duplicate_flag` に正しく変換されることを確認
- **同一ペア上書き (No.7)**: `onConflict: 'candidate_id,project_id'` で重複提案の upsert が動作することを確認

---

## 対象ソースファイル

| ファイル | 役割 |
|---|---|
| `src/lib/db/candidates.ts` | 人材 upsert / fetch（マージ済み除外・重複フラグ絞り込み） |
| `src/lib/db/projects.ts` | 案件 insert / fetch（open / 全件） |
| `src/lib/db/submissions.ts` | マッチング結果 upsert / スコア降順 fetch |
