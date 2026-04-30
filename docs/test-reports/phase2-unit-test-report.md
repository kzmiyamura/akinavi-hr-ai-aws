# 単体テスト項目書 兼 結果報告書
## Phase 2: AI プロバイダー抽象化 & Gemini 1.5 Flash

- **実施日**: 2026-04-30
- **実施者**: Claude Code (claude-sonnet-4-6)
- **テストフレームワーク**: Vitest v4.1.5
- **対象ファイル**: `src/lib/ai/`

---

## テスト結果サマリー

| 項目 | 件数 |
|---|---|
| テストファイル | 1 |
| テスト総数 | 9 |
| **合格** | **9** |
| 失敗 | 0 |
| 実行時間 | 約 1.3 秒 |

---

## テスト項目一覧

### analyzeCandidate（人材情報解析）

| # | テストケース | 確認内容 | 結果 |
|---|---|---|---|
| 1 | テキストから人材情報を正しく抽出する | name / email / skills / experienceYears が正しく抽出される | ✅ PASS |
| 2 | コードブロック付きレスポンスも正しくパースする | Gemini が ` ```json ... ``` ` を返した場合でも JSON パースが成功する | ✅ PASS |
| 3 | email が null の場合も正しく扱う | 情報不明時に email=null, skills=[] が返る | ✅ PASS |

### analyzeProject（案件情報解析）

| # | テストケース | 確認内容 | 結果 |
|---|---|---|---|
| 4 | テキストから案件情報を正しく抽出する | title / client / requiredSkills / budgetMin / budgetMax が正しく抽出される | ✅ PASS |
| 5 | 単価不明の場合 null を返す | budgetMin / budgetMax が null で返る | ✅ PASS |

### matchCandidateToProject（マッチングスコアリング）

| # | テストケース | 確認内容 | 結果 |
|---|---|---|---|
| 6 | スコアとサマリーを返す | score が 0〜100 の範囲、summary が文字列で返る | ✅ PASS |
| 7 | 類似候補がいる場合 duplicateSuspected=true を返す | AI が類似判定した際に duplicate_flag 用フラグが true になる | ✅ PASS |

### プロバイダー切り替え

| # | テストケース | 確認内容 | 結果 |
|---|---|---|---|
| 8 | VITE_AI_PROVIDER=gemini のとき ai オブジェクトが定義される | ファクトリが geminiProvider を返す | ✅ PASS |
| 9 | VITE_AI_PROVIDER=openai のとき未実装エラーをスローする | openaiProvider が「未実装」エラーを返す（切替スタブの動作確認） | ✅ PASS |

---

## テスト設計のポイント

- **Gemini SDK をクラスモック**: `GoogleGenerativeAI` をクラス構文でモックし、`generateContent` の戻り値をテストごとに差し替え
- **コードブロック除去のテスト (No.2)**: Gemini が ` ```json ``` ` で返す実挙動に対応した `parseJSON` 関数の確認
- **null ハンドリング (No.3, 5)**: 情報不足時の安全な null 返却を確認
- **duplicate_flag 連携 (No.7)**: Phase 3 の名寄せ機能に向けた `duplicateSuspected` フラグの動作確認
- **環境変数切り替え (No.8, 9)**: `VITE_AI_PROVIDER` 変数によるプロバイダー差し替えの確認

---

## 対象ソースファイル

| ファイル | 役割 |
|---|---|
| `src/lib/ai/types.ts` | AIProvider インターフェース・型定義 |
| `src/lib/ai/geminiProvider.ts` | Gemini 1.5 Flash 実装 |
| `src/lib/ai/openaiProvider.ts` | OpenAI 切替用スタブ |
| `src/lib/ai/index.ts` | プロバイダーファクトリ（環境変数で切替） |
