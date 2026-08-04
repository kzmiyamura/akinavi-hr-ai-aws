# llm_extract — Haiku+Sonnet 併用 LLM 抽出プロトタイプ（別枠）

既存の regex パイプライン（`supabase/functions/inbound-email/`）には**一切手を入れない**独立実装。
本番移植前の検証用。設計の背景は 2026-08-02 のモデルベンチ
（`~/Downloads/model_bench_haiku_sonnet_vs_fable_20260802.json`、メモリ `project-llm-reading-bench`）。

## アーキテクチャ

```
xlsx ──buildGridInput──▶ グリッド+結合セルJSON（無損失整形。解釈は一切しない）
                              │
                              ▼
                    Haiku 4.5 で「転記」 ←── モデルの仕事は転記のみ。計算させない
                              │
                              ▼
                    機械検証 (verify.mjs) ←── regex資産は審判として再利用
                     ├─ pass ──▶ 採用 (model=haiku)
                     └─ 落第 ──▶ Sonnet 5 で再転記
                                   ├─ ハードゲートpass ─▶ 採用 (model=sonnet)
                                   └─ 落第 ─▶ status=needs_review（人間レビュー行き）
                              │
                              ▼
                    skillYears計算 (JS: 暦区間union) ←── 数値はモデルに任せない
```

## 検証ゲート（verify.mjs）

| ゲート | 検出する失敗 | 段階 |
|---|---|---|
| project_shortfall | 案件ブロックの取り落とし（グリッドの日付範囲セル数と比較） | 両方 |
| tech_coverage | セル内分割サボり・列読み飛ばし（グリッド内英字トークン捕捉率 < 0.63） | Haiku段のみ |
| empty_techs | 期間↔技術の対応付け失敗 | Haiku段のみ |
| month_label | 日付誤読（「Nヶ月」明示ラベルとの不一致） | 両方 |
| bad_dates / no_projects / self_low_confidence | 出力崩れ・自己申告 | 両方 |

キャリブレーション（2026-08-05、ベンチ11ファイル）: Haiku の真の失敗4件（022/031/054/017）を
全捕捉、誤昇格2件。昇格率 6/11。実効精度はほぼ Sonnet 単独と同等でコストは約半分。

## 使い方

```bash
# 経歴書1ファイル
node scripts/llm_extract/run.mjs path/to/経歴書.xlsx

# メール本文（常にHaiku）
node scripts/llm_extract/run.mjs --body path/to/body.txt

# ベンチ一括（入力グリッドdir + Fable基準dir）
node scripts/llm_extract/bench.mjs <inputsDir> <refDir>
```

モデル呼び出しは既定で `claude -p`（サブスク枠・検証用）。`ANTHROPIC_API_KEY` があれば API 直。

## 本番移植時のメモ（Edge Function化）

- caller を Anthropic SDK + **Batch API**（50%オフ・翌ポーリングで結果回収）に置換。
  structured outputs（`output_config.format` json_schema）で JSON 保証に格上げする
- `buildGridInput` は Deno でも動く（XLSX と worksheetToGrid は inbound-email に既存）
- 図形/テキストボックス検知（drawings XML）→ ある場合はシート画像レンダリング経路へ（未実装）
- skill_master 照合・駅名解決・重複判定は既存の後段をそのまま使う
- コスト目安: Haiku $1/$5 per Mtok、Sonnet $3/$15（intro $2/$10 〜2026-08-31）。
  1通あたり入力2〜20k tok。2,000通/日・昇格3割で月$300〜500（Batch適用後）
- **PII注意**: テストは実データを使うが、実ファイル・出力はリポジトリにコミットしない
