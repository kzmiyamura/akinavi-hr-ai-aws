# AI モデルフォールバックフロー

`supabase/functions/inbound-email/`, `match-score/`, `auto-match/`, `poll-email/` の実装に基づく。

> **歴史的注意（2026-05-19 / コミット `139a4f2`）**  
> `inbound-email` の AI 解析パス（STEP1 関連性チェック + STEP5 人材情報抽出）は**完全に廃止**された。  
> メール解析は AI を一切呼ばず、regex + 文章スキャン + `skill_master` DB 照合のみで構造化抽出する。  
> 旧 STEP1 / STEP5 のフォールバックフローは過去資料として末尾に保管する。

---

## 現行 AI 使用箇所マップ

| Edge Function / 場所 | 用途 | AI 使用 | フォールバック順 |
|---|---|---|---|
| `inbound-email` STEP5 構造化抽出 | 候補者情報の抽出 | **不使用** | — |
| `inbound-email` STEP1 関連性チェック | 不要メール早期除外 | **不使用**（コード残存・未呼び出し） | — |
| `inbound-email` 自動マッチ（`AUTO_MATCH_ENABLED=true` 時） | 即時スコア計算 | 使用 | Gemini 単発（`matchCandidateToProject`） |
| `match-score` Edge Function（UI 手動マッチ） | スコア計算 | 使用 | **Cerebras `llama3.1-8b` → Groq `llama-3.3-70b-versatile` → Gemini `gemini-2.5-flash`** |
| `auto-match` Edge Function（毎朝 JST 9:00 cron） | バッチスコア計算 | 使用 | **Gemini `gemini-2.5-flash-lite` 単発のみ**（フォールバックなし） |
| `poll-email` メール種別バッチ分類 | 同一受信箱内の candidate/project/other 判定 | 使用（既定 OFF） | Gemini `gemini-2.5-flash-lite` 単発（バッチサイズ最大 20） |
| ブラウザ（人材・案件登録時の入力解析） | テキスト・画像解析 | 使用 | Gemini `gemini-2.5-flash-lite` 単発 |

---

## メール解析の現行パイプライン（AI 不使用）

`inbound-email/index.ts` の STEP5 は AI を使わず以下のステップで動く。

```
Outlook 受信メール
  └─► poll-email（5 分ごと pg_cron・最大 50 件/アカウント）
        └─► inbound-email
              ├─ [STEP0-2] メタ情報・本文・添付の受け取りと検証
              ├─ [STEP3] Word/Excel 添付をテキスト変換（PDF は Storage 保存のみで解析せず）
              ├─ [STEP4] Google Drive / Sheets / Docs URL を検出して取得
              ├─ [STEP5] 構造化抽出（AI 不使用）
              │     ├─ stripUrlsForSkillMatching（URL を空白置換 → PHP/HTTPS の誤マッチ防止）
              │     ├─ stripSenderSignature（送信者署名以降を除去）
              │     ├─ extractAndRemoveSkills（skill_master DB 照合）
              │     │     - 本文: 厳密照合（資格は certContext 内のみ）
              │     │     - 添付: フォーマット崩れ対応（資格は looseCert=true で全文 fallback）
              │     ├─ filterBySkillRating（スキルシート A〜E 評価のうち D/E を除外）
              │     ├─ extractCandidateFieldsRegex（氏名・最寄駅・都道府県・経験年数・希望単価・参画時期・希望案件）
              │     ├─ inferPrefectureFromStation（駅 → 都道府県マップで署名由来の誤判定を上書き）
              │     ├─ extractFromProse（PROSE_ROLES / PROSE_INDUSTRIES）
              │     │     - isPhaseTableHeader でフェーズ表ヘッダー行を除外
              │     └─ splitMultiCandidateBody（1 メール = 複数候補者を分割）
              ├─ [STEP6] 重複判定（名前完全一致 + スキル Jaccard ≥ 0.4 → duplicate_flag=true）
              ├─ [STEP7] DB 保存（candidates / candidate_skills / ai_logs。ai_logs.model='no-ai'）
              └─ [STEP8] AUTO_MATCH_ENABLED=true なら matchCandidateToProject 経由で即時スコア（任意・既定 OFF）
```

ポイント:
- `inbound-email` 用に必要な Secrets は `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` のみ。`GEMINI_API_KEY` 等は不要
- 案件メールの処理は `app_config.inbound_project_enabled='true'` のときだけ実行される（既定 OFF）

---

## `match-score`（UI 手動マッチ）のフォールバック

> マッチングはスコア計算のみで軽量タスク → Cerebras 8B が有効。失敗時のみ Groq 70B → Gemini にエスカレート。

```
Cerebras llama3.1-8b
  ├─ 成功 → スコアを返す
  └─ 失敗
       └─► Groq llama-3.3-70b-versatile
             ├─ 成功 → スコアを返す
             └─ 失敗（429 TPD 超過 / タイムアウト等）
                  └─► Gemini gemini-2.5-flash
                        └─ 成功 → スコアを返す
```

`Promise.allSettled` ベースで並列実行する箇所もあるが、1 ペアあたりのフォールバック順は上記。

---

## `auto-match`（毎朝 JST 9:00 cron）

- 直近 25 時間以内に登録された `prod` の案件に対し、スキル重複でフィルタした最大 40 名を `submissions` に追加
- スコア計算は **Gemini `gemini-2.5-flash-lite` 単発のみ**。Cerebras/Groq フォールバックは持たないため、Gemini クレジット枯渇時はその回のバッチが失敗する
- 既存ペア / `accepted` 状態の人材は除外

---

## `poll-email` メール種別分類（任意・既定 OFF）

- `app_config.email_classify_enabled='true'` のときのみ動作
- 同一受信箱に candidate / project が混在するケース用
- Gemini `gemini-2.5-flash-lite` バッチで最大 20 件/コール、10 秒タイムアウト
- 失敗時は `candidate` にフォールバック
- ルールベース事前フィルタ（`SKIP_*_PATTERNS`, `PROJECT_*_PATTERNS`, `HR_SUBJECT_PATTERNS`）で自動判定できたメールは AI を呼ばずに分類

---

## モデル一覧・特性

| モデル | 用途 | 無料枠 | コンテキスト |
|---|---|---|---|
| Cerebras `llama3.1-8b` | `match-score` の 1 段目 | 実質無制限 | 8K tokens |
| Groq `llama-3.3-70b-versatile` | `match-score` の 2 段目 | 500K tokens/日（JST 9:00 リセット） | 128K tokens |
| Groq `llama-3.1-8b-instant` | コード上は残存するが呼び出されない（poll-email 用に使われる場合あり） | 500K tokens/日 | 128K tokens |
| Gemini `gemini-2.5-flash` | `match-score` 最終フォールバック | プリペイド制 | 1M tokens |
| Gemini `gemini-2.5-flash-lite` | `auto-match` / `poll-email` 分類 / ブラウザ入力解析 | プリペイド制 | 1M tokens |

---

## Groq / Gemini 枯渇時の挙動（マッチング処理）

```
Groq → 429 Too Many Requests（日次上限超過）
  └─► Gemini にフォールバック
        ├─ クレジットあり → 正常動作
        └─ クレジットなし → スコア計算失敗
              ├─ match-score: UI 側でエラー表示・リトライ可能
              └─ auto-match: 当該バッチをスキップ（次回 cron で再実行されない）
```

> JST 9:00 に Groq トークンがリセットされると自動復旧。  
> マッチング処理が天井になる運用なら Groq 有料プラン（~$4/月）または Gemini クレジット追加を検討。  
> **メール処理側は AI を使わないため、件数に関わらず無料で永続稼働する**。

---

## 廃止済み（参考・歴史）

> 以下は 2026-05-19 のコミット `139a4f2` で廃止された旧フロー。`inbound-email/index.ts` には関数定義（`classifyInboundRelevance`, `generateJSONSmart`, `buildCandidateGroqPrompt` 等）が残るが、どこからも呼ばれない。

### 旧 STEP1: 関連性チェック（`classifyInboundRelevance`）

```
Cerebras 8B（llama3.1-8b）
  ├─ 成功 → relevant: true/false
  └─ 失敗
       └─► Groq 8B（llama-3.1-8b-instant）
             └─ 失敗
                  └─► Gemini gemini-2.5-flash-lite
```

### 旧 STEP5: 人材情報抽出（`generateJSONSmart` kind='candidate'）

```
画像添付あり OR (Cerebras/Groq キーなし)
  └─► Gemini gemini-2.5-flash-lite（画像対応）

それ以外
  └─► Groq llama-3.1-8b-instant
        └─ 失敗
             └─► Gemini gemini-2.5-flash-lite
```

- 廃止理由: Groq 無料枠 500K TPD = 約 125 件/日でメール取り込みが頻繁に詰まり、無限リトライループに陥っていた
- regex / 文章スキャン / `skill_master` 照合だけで実用精度を維持できると判断
- 削除されたコードは後日整理予定

---

*最終更新: 2026-05-20*
