# メール人材登録 AIモデルフォールバックフロー

`supabase/functions/inbound-email/index.ts` の実装に基づく。

---

## 全体フロー概要

```
Outlook受信メール
  └─► poll-email（5分ごとpg_cron）
        └─► inbound-email
              ├─ [STEP1] 関連性チェック（不要メールの早期除外）
              ├─ [STEP2] 重複チェック
              ├─ [STEP3] 添付ファイル抽出（Word/Excel → テキスト化）
              ├─ [STEP4] Google Driveリンク取得
              ├─ [STEP5] 人材情報抽出（AI）
              │     ├─ フル解析（本文＋添付テキスト）
              │     └─ 品質不足時: 本文のみで再解析
              └─ [STEP6] DB保存（candidates テーブル）
```

---

## STEP1: 関連性チェック（`classifyInboundRelevance`）

> 人材・案件と無関係なメール（自動返信・通知等）を早期除外する。

```
Cerebras 8B（llama3.1-8b）
  ├─ 成功 → relevant: true/false を返す
  └─ 失敗
       └─► Groq 8B（llama-3.1-8b-instant）
             ├─ 成功 → relevant: true/false を返す
             └─ 失敗
                  └─► Gemini 2.5 Flash Lite（gemini-2.5-flash-lite）
                        └─ 成功 → relevant: true/false を返す

relevant: false → スキップ（200 OK で終了）
relevant: true  → STEP2へ
```

**ポイント:**
- タイムアウト: 15秒
- 軽量タスクなので Cerebras 8B が有効
- 失敗時は `relevant: true`（スキップせず）にフォールバック

---

## STEP5: 人材情報抽出（`generateJSONSmart` kind='candidate'）

> 氏名・スキル・経歴等を構造化JSON で抽出する。

### 通常パス（フル解析）

```
画像添付あり OR (Cerebras/Groq キーなし)
  └─► Gemini 2.5 Flash Lite（gemini-2.5-flash-lite）※画像対応
        └─ 添付バイナリ＋本文で解析

画像添付なし かつ キー設定あり
  └─► Groq 8B（llama-3.1-8b-instant）
        ├─ 成功 → 結果を返す
        └─ 失敗（429 TPD超過 / タイムアウト等）
               └─► Gemini 2.5 Flash Lite（gemini-2.5-flash-lite）
                     └─ 成功 → 結果を返す
```

**ポイント:**
- Cerebras は候補者/案件抽出には不使用（8Bでは複雑な日本語構造化抽出に不足）
- プロンプトには本文（3000文字）＋添付テキスト（3000文字）を含む
- Groq の日次トークン上限（500K TPD）はUTC 0:00（JST 9:00）リセット
- **無料枠での処理上限: 約125件/日**（500K ÷ 約4,000トークン/件）

### 品質チェック → 本文のみ再解析

```
フル解析の結果
  ├─ name が存在 かつ skills > 0 → OK、DB保存へ
  └─ (name なし / "不明") かつ skills = 0 かつ 添付テキストあり
         └─► 本文のみで再解析（attachments なし・driveTextSection 除去）
               └─► Groq 8B → Gemini（同じフォールバック順）
```

**ポイント:**
- 添付ExcelやWordが長すぎてAIが混乱する場合に有効
- 本文だけなら氏名・基本情報は取れることが多い

---

## 自動マッチング（`generateJSONSmart` kind='match'）

> 人材登録後、案件とのマッチングスコアを自動計算する（`AUTO_MATCH_ENABLED=true` 時）。

```
Cerebras 8B（llama3.1-8b）
  ├─ 成功 → スコアを返す
  └─ 失敗
       └─► Groq 8B（llama-3.1-8b-instant）
             ├─ 成功 → スコアを返す
             └─ 失敗
                  └─► Gemini 2.5 Flash Lite（gemini-2.5-flash-lite）
                        └─ スコアを返す
```

**ポイント:**
- マッチングはスコア計算のみで軽量タスク → Cerebras 8B が有効
- `match-score` Edge Function（UIからの手動マッチング）も同じフロー

---

## モデル一覧・特性

| モデル | 用途 | 無料枠 | コンテキスト |
|---|---|---|---|
| Cerebras `llama3.1-8b` | 関連性チェック・マッチングスコア | 実質無制限 | 8K tokens |
| Groq `llama-3.1-8b-instant` | 候補者/案件構造化抽出（メイン） | **500K tokens/日**（JST 9:00リセット）≈ **125件/日** | 128K tokens |
| Gemini `gemini-2.5-flash-lite` | フォールバック・画像解析 | プリペイド制（要チャージ） | 1M tokens |

> Groq 70B（100K TPD = 約25件/日）は2026-05-16に8b-instant（500K TPD = 約125件/日）へ変更済み。

---

## Groq 枯渇時の挙動

```
Groq → 429 Too Many Requests（日次上限超過・約125件/日）
  └─► Gemini にフォールバック
        ├─ クレジットあり → 正常動作
        └─ クレジットなし → 登録失敗（500エラー）
```

> JST 9:00 に Groq トークンがリセットされると自動復旧。  
> 125件/日を超える運用が必要な場合は Groq 有料プラン（~$4/月）または Gemini チャージが必要。

---

*最終更新: 2026-05-16*
