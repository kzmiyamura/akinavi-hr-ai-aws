# プロジェクト概要: AkiNavi HR-AI（アキナビ HR-AI）

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。

## 2. 技術スタック
- **Frontend**: React 19 (Vite 8), TypeScript, Tailwind CSS v4, TanStack Query v5
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, pg_cron, pg_net)
- **ファイルパース（ブラウザ）**: `xlsx`（Excel）・`mammoth`（Word）— `src/lib/fileParser.ts`。PDF・画像は未対応
- **AI（ブラウザ）**: Gemini `gemini-2.5-flash-lite`（`VITE_GEMINI_MODEL` で上書き可）。人材・案件登録 UI からは呼ばない
- **AI（サーバー・マッチング）**: Cerebras `llama3.1-8b` → Groq `llama-3.3-70b-versatile` → Gemini `gemini-2.5-flash`（3段フォールバック）。`match-batch` / `match-score` / `auto-match` が使用
- **AI（サーバー・メール解析）**: AI 不使用。regex + `skill_master` DB照合のみ（`inbound-email` Edge Function）
- **メール自動取り込み**: Microsoft Graph API ポーリング + pg_cron（5分間隔）
- **Testing**: Vitest, React Testing Library, MSW
- **Deployment**: Vercel (Frontend), Supabase (Backend)

---

## 3. Claude Code 操作権限ポリシー

### 確認なしで即実行してよい操作

| カテゴリ | 具体例 |
|---|---|
| ファイル読み書き | Read / Edit / Write |
| TypeScript ビルド確認 | `npx tsc --noEmit` |
| テスト実行 | `npm test` / `npx vitest run` |
| 依存パッケージ追加 | `npm install <package>` |
| Edge Function デプロイ | `bash scripts/check-and-deploy-edge.sh <function>` |
| Git 操作（通常） | `git add` / `git commit` / `git push` |
| GitHub Issue 操作 | Issue 作成・クローズ |
| Supabase SQL 実行 | `supabase db query --linked -f <file>` |

### 必ず確認してから実行する操作

| カテゴリ | 具体例 |
|---|---|
| 強制 push | `git push --force` |
| ブランチ削除 | `git branch -D` |
| 大量削除 | `rm -rf` / DB テーブル DROP / `DELETE` 条件なし |
| 本番データ変更 | Supabase prod テーブルへの直接 UPDATE / INSERT |
| 環境変数・Secrets 変更 | Supabase Secrets の追加・変更・削除 |
| 外部サービス設定変更 | Azure / GitHub / Vercel の設定変更 |
| 課金が発生する操作 | 有料 API の大量呼び出し・プラン変更 |

---

## 4. 行動指針

- **正の所在**: 仕様はソースコードが正。CLAUDE.md と食い違いがあればソースに合わせて本ファイルを更新する
- **こまめな Git 操作**: 機能実装単位・テスト通過ごとに commit & push
- **バグゼロの追求**: ロジックには必ずテストコードを付随させる
- **Issue 作業サイクル（自律ループ）**:
  1. `node scripts/list_issues.mjs` で open Issue を確認
  2. 実装・修正・テスト → commit & push
  3. `node scripts/list_issues.mjs --close <番号>` でクローズ
  4. open Issue が 0 件になるまで繰り返す（ユーザーへの確認不要）
- **Excel/Word解析 精度改善サイクル（自律ループ）**: 手順は下記「Excel/Word解析 精度改善ループ」参照。以下をユーザー確認なしで繰り返す
  1. `node scripts/test_excel_parsing.mjs --compact --new` で WARN・FAIL・誤抽出（案件名をスキルと誤認識 等）を洗い出す
  2. 仮説立案 → `supabase/functions/inbound-email/index.ts` の抽出関数を修正
  3. `node scripts/sync_extractors.mjs` で再生成
  4. 再テストし、既存回帰（`testData/excel/*.xlsx` 10件・`testData/failures/*.txt` 3件）が **0件劣化** であることを確認してから次へ進む（劣化していたら修正をやり直す）
     ※ `testData/excel/` は PII のため git 管理外。**空だと Total 0 で空回りする**（2026-08-10 に発覚）。
       空なら `node scripts/download_failing_excels.mjs` で実データを再取得してから測ること
  5. `--log` で改善内容を記録 → `check-and-deploy-edge.sh inbound-email` でデプロイ → commit & push
  6. 新規 WARN/FAIL/誤抽出が無くなるまで 1〜5 を繰り返す

### よく使うスクリプト
- `node scripts/list_issues.mjs [--close N]` — GitHub Issue 一覧取得・クローズ
- `node scripts/test_extraction.mjs "本文"` — regex 抽出をデプロイなしでローカル検証（変更前後に必ず使う）。**注意: index.ts と自動同期されない手書きレプリカ**のため判定が本番と食い違うことがある（会社名抽出等）。正は `supabase/functions/inbound-email/index.ts`。本番との差異検証は実データ再解析で行う
- `node scripts/check_extraction.mjs` — 直近14日の取りこぼし調査
- `bash scripts/check-and-deploy-edge.sh <function>` — deno check + deploy（Edge Function は必ずこれを使う）
- `node scripts/test_excel_parsing.mjs --compact` — Excel/Word解析品質メトリクス（Claude読み取り用）
- `node scripts/test_excel_parsing.mjs --compact --new` — 未分類 xlsx も含めて検証
- `node scripts/test_excel_parsing.mjs` — 詳細デバッグ出力（人力調査用）
- `node scripts/test_excel_anomalies.mjs` — 想定異常系の合成テスト（34ケース）。新しい異常フォーマットを発見したらまずここにケースを足してから修正（テストファースト）
- `node scripts/sync_extractors.mjs` — index.ts の純粋関数を `_extractors.gen.mjs` に再生成（index.ts を変更したら必ず実行）

### Excel/Word解析 精度改善ループ

```
# 1. 品質チェック（コンパクト出力）
node scripts/test_excel_parsing.mjs --compact

# 2. 失敗ファイルを調査（詳細出力で仮説立案）
node scripts/test_excel_parsing.mjs     # 詳細で [DBG] を確認

# 3. index.ts の抽出関数を修正（正：supabase/functions/inbound-email/index.ts）

# 4. _extractors.gen.mjs を再生成
node scripts/sync_extractors.mjs

# 5. 改善確認
node scripts/test_excel_parsing.mjs --compact

# 6. 記録・デプロイ・コミット
node scripts/test_excel_parsing.mjs --log "変更内容メモ"
bash scripts/check-and-deploy-edge.sh inbound-email
git add -A && git commit -m "fix: ..." && git push
```

**注意**:
- 修正対象は常に `supabase/functions/inbound-email/index.ts`。`_extractors.gen.mjs` は自動生成なので直接編集しない
- `testData/excel/*.xlsx`（10件）がリグレッションテスト用。`testData/failures/*.txt`（3件）がテキスト抽出テスト用
- `excel_golden.json` は **`_verified: 未確認` のスナップショット**であって「正解」ではない。
  回帰検出には使えるが精度保証にはならない（詳細は `testData/excel_golden_review.md`）
- 新しい問題 Excel は `testData/excel/` に追加して再テスト
- 改善履歴は `scripts/testData/improvement_log.md` を参照

### スキル
- `/issue-loop` — Issue 自律修正ループ
- `/deploy-edge` — Edge Function デプロイ
- `/quality-check` — skill_master メンテ・駅名マッピング・取りこぼし調査・異常監視

---

## 5. データベース構成

`candidate_skills` のカテゴリ CHECK 制約は `supabase/migrations/add_candidate_skills.sql` を正とする。

### テーブル一覧
| テーブル | 用途 |
|---|---|
| `candidates` | 人材マスタ。`data_env`（`prod`/`demo`）で論理分離。主要カラム: `box_url`, `resume_url`, `drive_url`, `desired_rate`, `from_company`, `duplicate_flag`, `merged_into` |
| `projects` | 案件マスタ。`data_env` 同上 |
| `submissions` | マッチング提案履歴 |
| `candidate_skills` | スキルをカテゴリ別に分解（14カテゴリ） |
| `candidates_archive_light` | 人材マップ用サマリー。7日経過 prod 人材を `archive-candidates` Edge Function が毎日 JST 0:00 に移動 |
| `ai_logs` | AI呼び出しログ。`inbound-email` 由来は `model='no-ai'` |
| `error_logs` | フロントエンドエラーログ。30日自動削除 cron は未実装（要追加） |
| `skill_master` | ITスキルマスタ（951件）。aliases で表記ゆれ吸収。更新すると `skill_norm_map` がトリガで貼り直される |
| `skill_norm_map` | **マテリアライズドビュー**。skill_master の正式名＋別名 → 正式名の正規化辞書。マッチングのスキル一致判定用 |
| `skill_implications` | 「childを持つ人はparent要件も満たす」向きのある包含関係（MySQL→SQL 等）。別名では表現できない関係を扱う |
| `station_master` | 駅名・路線名→都道府県マッピング（ekidata.jp実データ、12,666行・8,443駅名。同名駅は路線で判別。路線不明時は首都圏の県を優先採用＝2026-08-08ユーザー判断、首都圏同士で割れたらnull）。`scripts/export_station_master.mjs` で `supabase/functions/inbound-email/station_data.json` に書き出し、Edge Functionにビルド時同梱（実行時DB問い合わせなし）。DB更新時は再エクスポート＋再デプロイが必要 |
| `app_config` | アプリ全体設定・Microsoft OAuthトークン保存 |
| `notification_rules` | 人材ウォッチ通知ルール（通知タブでCRUD）。7/23復旧日にマイグレーション適用 |
| `notification_log` | 通知送信済み記録（ルール×人材で一意・二重通知防止） |

### app_config の主要キー
| キー | 既定 | 内容 |
|---|---|---|
| `inbound_project_enabled` | `false` | 案件メールの解析・DB保存を有効化 |
| `auto_match_enabled` | `true` | `auto-match` cron を有効化 |
| `email_poll_mode` | `incremental` | `incremental`（未読のみ）/ `full`（指定日以降全件） |
| `email_classify_enabled` | `false` | poll-email 内の Gemini メール種別分類 |
| `matching_run_mode` | `fast` | `fast` / `full`。SettingsPage から変更可 |
| `matching_fast_max_candidates` | `20` | 高速モード時の案件あたり候補者上限 |
| `matching_fast_max_projects` | `10` | 高速モード時の人材あたり案件上限 |
| `candidate_retention_days` | `7` | 人材データ保持日数 |
| `app_memo` | — | 営業引き継ぎ用フリーテキスト |

---

## 6. アーキテクチャメモ

- **マッチングスコア計算**: `fetch_candidates_for_project` RPC（SQL）でルールスコアを計算 → topN件だけ AI 採点。スコア配点・ウェイト詳細はRPC定義を参照
- **スキル一致判定**: 実体は `skill_hit_weights()`、定義は `skill_satisfies()`（`20260812_skill_match_normalize.sql`）。
  正規化（skill_master の別名）＋包含関係（`skill_implications`）＋語境界の3つで判定する。
  **部分一致は使わない**（`JavaScript` が `Java` に、`Shell` が `PowerShell` に一致していた）。
  `fetch_candidates_for_project` / `auto-match` / マッチング画面の緑表示は全てこの判定を共有する。
  判定を変えたら `scripts/sql/test_skill_matching.sql` と `test_skill_matching_rpc_parity.sql` を実行する
- **inbound-email 処理フロー**: `supabase/functions/inbound-email/index.ts` を参照
- **論理データ環境**: `prod` / `demo` を `data_env` カラムで分離。SettingsPage の「デモモード」スイッチで切替
- **画面構成**: ナビは5タブ（マッチング/人材/案件/通知/設定）。`src/components/Layout.tsx` の `NAV_ITEMS` を正とする
- **通知機能**: `notification_rules`（条件: 名前/スキル/駅のAND）に合致する人材が登録・更新されたら `notify-candidates` Edge Function（pg_cron 5分）が Graph sendMail でメール通知。二重通知は `notification_log` で防止。送信には Mail.Send スコープ（Microsoft再連携）が必要
- **認証なし**: ニックネームを `localStorage` に保存
- **表示優先スキル**: 既定は `app_config.llm_filter_skills`（設定画面「AI校正の優先スキル」＝常駐AIの解析対象と共有）。
  人材画面の絞り込みポップアップから**端末ごとに上書き**でき、ON/OFF と中身を `localStorage`
  （`akinavi.prioritySkills.v1`）に保存する。ロジックは `src/lib/prioritySkillPref.ts`。
  認証が無くユーザーを識別できないため端末単位。AI校正バッジ（`aiCorrectionStage`）は
  ワーカーの実際の対象を表すので**端末設定ではなく app_config の値**を使う
- **重複管理**: email一致で自動UPDATE。名前一致 + スキルJaccard ≥ 0.4 で `duplicate_flag=true`

## ⚠ Egress を使わずに検証する（2026-08-14 ユーザー指示）

**実装・テスト・検証で本番からデータを引かない。egress はユーザーが画面で確認する分に取っておく。**

Free Plan の egress 5GB に対し 8/14 時点で 2.98GB 消費・残り9日、
ダッシュボードに「Grace period is over（枠を使い切るとリクエストを返せなくなる）」が出ている。
8/13 単日 822MB のうち **94% が PostgREST**（ブラウザとスクリプトの DB 読み取り）。

| やらない | 代わりに |
|---|---|
| 行を引いて JS 側で数える・測る | `supabase db query` で **SQL に集計させて数行だけ返す**（`count(*)` / `pg_column_size()`） |
| 件数確認に `select=*` | `select=id` + `Prefer: count=exact` の HEAD（本文ゼロ） |
| 本番相手の疎通確認 | `npx vitest run` / `node --check` / `npx tsc --noEmit` / `npm run build` |
| 転送量を実データで実測 | ローカルスタック（`supabase start`＋`scripts/local_test_seed.sql`）で測る |

`sb-query.mjs` は**少量の1件確認だけ**に使う。一覧取得・全件走査には使わない。
同じ確認を複数回流さない（8/14 に `check_range.mjs` で1000件フル取得を6回流し、
21.4MB 使って得た結論は1行だった）。

転送量を測りたいときは**本体を受け取らずに SQL で測る**:

```sql
SELECT octet_length(json_agg(t)::text) AS bytes
FROM (SELECT * FROM candidates_lite WHERE data_env = 'prod' LIMIT 200) t;
```

**削減の残タスクは HANDOFF.md 「Egress 削減の残タスク」を参照**（最優先は
ランキングの遅延取得：案件1クリック 1.63MB → 約230KB）。

### 具体的な鉄則（どのPCで作業するときも守る・2026-08-19 追記）

このファイルはリポジトリに入っているので pull すればどのマシンでも効く。
逆に、各マシンのメモリ（`~/.claude/.../memory/`）は**他のPCには届かない**ので、
恒久的に守らせたい判断基準はここに書く。

- **`raw_profile` を丸ごと select しない。** 1件あたり約35KB（`attachmentText` が約13KB）。
  300件引けばそれだけで10MB。必要な項目だけ JSON パスで取る:
  `select=id,sy:raw_profile->skillYears,checked:raw_profile->>_llm_checked_at`
- **件数を数えるためにレコードを取らない。** `select=count` か HEAD + `Prefer: count=exact`
- **PostgREST は 1000 行で黙って切る**（`db-max-rows`）。Range ヘッダは RPC に効かない。
  1000 を超えうる取得は SQL 側に `p_offset` を持たせてページングする
- **RPC の検証ループが盲点。** `fetch_candidates_for_project` は1回で約1MB（500件×約2KB）。
  8案件を1周で8MB。**性能・安定性の確認は1案件・少件数で足りる**
- **同じ結果を取り直さない。** 1度取ったらスクラッチパッドに保存して使い回す
- **本番相手に dev サーバーを起動して画面を何度もリロードしない**（2026-08-17 に実施して
  指摘された）。画面込みの確認が要るなら demo（`data_env='demo'`）か
  ローカルスタックで行う

### 検証データは demo に自作する（2026-08-14 ユーザー指示「どうせ作るの君でしょ」）

**prod を引く前に「そのケースを自分で作れないか」を考える。** demo は人材53件なので
画面確認1回の egress が prod の数十分の一で済む。

1. ロジック単体 → ローカル（vitest / Excel Golden / 純関数テスト）
2. **経路として動くか（DB書き込み・画面表示・ワーカー込み）→ demo**
3. prod → 実データの分布そのものを見たいときだけ

```
node scripts/seed_demo_candidate.mjs --body <本文ファイル> [--attach <経歴書>]
node scripts/llm_extract/correct_candidate.mjs <id> [--run]   # 1人だけ即AI校正
```

ワーカーも `SHADOW_DATA_ENV=demo` で demo だけを処理できる（既定は prod）。
**大量データテストはやらない**（頼まれるまで手を出さない）。

### 測る前に推測を書かない（2026-08-13 の教訓）

原因の当てずっぽうは時間も egress も溶かす。設定値・実行時間は**先に1本のクエリで確認する**。
外した仮説を言い直すより、次の一手を測定にする。

- DB のキー名を推測して select し、**null が返ったのを「値が無い」の根拠にしない**。
  存在しないキーは必ず null を返す。まず1件だけ引いてキー名を確認する
- メール単位の値を人材行数ぶん並べて「N件で確認」と書かない（実質 n=1）
- **日次の使用量は日が変わるまで確定しない。** 途中の値を見て「減った」と報告しない
  （2026-08-17 に 33MB と報告したが、その日の最終値は 230MB だった）

## Supabase の調査クエリ

**`source ~/.akinavi_shadow.env && node -e "..."` は使わないこと。**
`source` も `node -e` も allowlist に登録できないため、実行のたびに承認ダイアログが出て
セッションが停止する。代わりに `scripts/llm_extract/sb-query.mjs` を使う。

```bash
node scripts/llm_extract/sb-query.mjs "candidates?id=eq.<uuid>&select=name,raw_profile"
node scripts/llm_extract/sb-query.mjs "candidates?select=id,name&limit=5" --raw
```

- env はスクリプト内で `~/.akinavi_shadow.env` から読むので `source` は不要
- GET 固定・書き込み不可（読み取り専用）
- 既定は要約表示。生 JSON が要るときは `--raw`
- 恒久許可済み: `Bash(node scripts/llm_extract/sb-query.mjs *)`

このスクリプトで足りない調査が出たら、その場限りの `node -e` を書くのではなく
sb-query.mjs に機能を足すか、新しいスクリプトファイルを作って引数化すること。
