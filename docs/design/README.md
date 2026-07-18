# 設計書一覧

ブラウザでHTMLを直接開いて閲覧する（`open docs/design/*.html`）。
Artifact版（claude.aiログインでどのデバイスからも閲覧可）と同内容:

| 設計書 | ファイル | Artifact URL |
|---|---|---|
| 添付・リンク処理フロー（ゾーンA〜E・T）実装完了版v5 | `inbound-email-flow-v5.html` | https://claude.ai/code/artifact/434fb4f0-ec05-4707-b179-2ee24c5b8fac |
| 添付・リンク処理フロー 平易版（v5の要約・専門用語少なめ） | `inbound-email-flow-easy.html` | — |
| Excel読み込みフロー v2（平易版+AIフォールバック概要） | `excel-reading-flow-v2.html` | https://claude.ai/code/artifact/02136939-1917-49d2-b607-49d3b2583713 |
| AIフォールバック詳細設計書 v1.2（スキル年数エンリッチ・HF Spaces） | `ai-enrich-design-v1.2.html` | https://claude.ai/code/artifact/70d4339d-92b7-4a52-924c-5d8f17160296 |
| AIフォールバック設計 平易版（上記の要約・専門用語少なめ） | `ai-enrich-design-easy.html` | https://claude.ai/code/artifact/ec4c9f7b-5b16-4b4f-9d15-0c1a15161758 |

- 実装状況: v5/v2は実装済みの現況図。AIフォールバックは**設計のみ・未実装**（レビュー中）。平易版は実装合意用ではなく説明用 — 正式仕様は v1.2 詳細設計書
- 関連: テスト項目書 `test_specification.html`（リポジトリ直下・gitignore対象のためローカルのみ）
