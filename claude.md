# プロジェクト概要: AkiNavi HR-AI（アキナビ HR-AI）

## 1. ビジョン
「案件の空き」と「人材（HR）リソース」をAIで最適に結びつける、高精度・高品質なマッチング基盤。

## 2. 技術スタック
- **Frontend**: React 19 (Vite 8), TypeScript, Tailwind CSS v4, TanStack Query v5
- **Backend/DB**: Supabase (PostgreSQL, Edge Functions, pg_cron, pg_net)
- **ファイルパース（ブラウザ）**: `xlsx`（Excel）・`mammoth`（Word）— `src/lib/fileParser.ts`。PDF・画像は未対応
- **AI（外部API）**: **2026-10-02 に全廃した。** Cerebras / Groq / Gemini はもう1つも呼ばない。
  理由は2つ。①採点プロンプトに経歴・スキル・単価が入っており**情報が社外に出る**
  （オンプレ版の売り文句を「情報漏洩対策」にする以上成立しない）。②AI は `claude -p`
  （Max サブスク）に一本化する。外す前に実測したら**ほぼ動いていなかった**
  （poll-email の種別分類は直近30日で185回試して185回とも失敗。`match-score` は
  呼び出し元がどこにも無い死んだ関数）。`match-score` / `enrich-candidate` は
  **2026-10-03 に本番の Edge Function ごと削除**した
- **AI（サーバー・メール解析）**: AI 不使用。regex + `skill_master` DB照合のみ（`inbound-email` Edge Function）
- **AI（ローカル・人材校正）**: `claude -p` を常駐ワーカー（pm2 `akinavi-shadow`）から呼ぶ。
  **`claude -p` は CLI なので Edge Function の中では動かせない**（API に替えると課金が発生する）。
  AI を足したくなったら必ずワーカー側に置く
- **マッチングの採点**: ルールスコアのみ（`fetch_candidates_for_project` RPC と
  `match-batch` の `calcRuleScore`）。`match-batch` は元から AI 失敗時にルールへ
  代替する作りだったので、経路そのものは従来どおり
- **メール自動取り込み**: Microsoft Graph API ポーリング + pg_cron（5分間隔）。
  第2経路として転送 + Webhook（`inbound-mail-webhook`）も用意した（既存の Graph 経路は無改造）。
  **`INBOUND_WEBHOOK_SECRET` が未設定なら全リクエストを 503 で拒否する**＝
  デプロイしてあっても secret を入れるまで何も起きない
- **Testing**: Vitest, React Testing Library, MSW
- **Deployment**: Vercel (Frontend), Supabase (Backend)

### フロントの配信でハマった点（2026-09-12）
- **型チェックは `npx tsc -b`。** `npx tsc --noEmit` はルートの `tsconfig.json`（`files: []`）
  だけを見るので**1ファイルも検査せず成功する**。長いあいだ型エラーを見逃していた
- `vercel.json` の `buildCommand` は **`tsc -b && vite build`**。
  `vite build` だけにすると型エラーがそのまま本番に出る
- **`vercel.json` にコメント用の `"//"` キーを足さない。** Vercel は未知の
  トップレベルプロパティを弾き、**ビルドに入る前にデプロイが失敗する**
  （2026-09-12 に実際に失敗させた）。メモはこのファイルに書く
- `rewrites` から **`assets/` を除外している**。除外しないと、消えたチャンクの URL に
  `index.html` が 200 で返り、ブラウザが
  「Failed to fetch dynamically imported module」を出す（404 なら原因が一目で分かる）
- 遅延読み込みは `lazy` ではなく **`src/lib/lazyPage.ts` の `lazyPage`** を使う。
  デプロイでチャンク名のハッシュが変わると、開いたままのタブが消えたファイルを掴むため、
  1回だけ自動でリロードする

---

## 3. Claude Code 操作権限ポリシー

### 確認なしで即実行してよい操作

| カテゴリ | 具体例 |
|---|---|
| ファイル読み書き | Read / Edit / Write |
| TypeScript ビルド確認 | **`npx tsc -b`**（`npx tsc --noEmit` は `files:[]` のルート設定だけを見るので**1ファイルも検査せず成功する**・2026-09-12 発覚） |
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
- `node scripts/check_extraction.mjs` — 直近7日（＝保持期間）の取りこぼし調査。
  **保持より長い日数を指定しない**。消えているだけなのに「取りこぼし0件」に見える
- `bash scripts/check-and-deploy-edge.sh <function>` — deno check + deploy（Edge Function は必ずこれを使う）
- `node scripts/test_excel_parsing.mjs --compact` — Excel/Word解析品質メトリクス（Claude読み取り用）
- `node scripts/test_excel_parsing.mjs --compact --new` — 未分類 xlsx も含めて検証
- `node scripts/test_excel_parsing.mjs` — 詳細デバッグ出力（人力調査用）
- `node scripts/test_excel_anomalies.mjs` — 想定異常系の合成テスト（34ケース）。新しい異常フォーマットを発見したらまずここにケースを足してから修正（テストファースト）
- `node scripts/sync_extractors.mjs` — index.ts の純粋関数を `_extractors.gen.mjs` に再生成（index.ts を変更したら必ず実行）
- `node scripts/mhlw_lookup.mjs "<社名>"` — 厚労省サイトで許可番号を引く（DBは触らない）。`--number 派13-xxxxxx` で番号から正式社名を引く
- `node scripts/reverify_agent_licenses.mjs <入力json> <出力json>` — agent_companies を一括で引き直す（結果はJSON、DBは触らない）
- `node scripts/gen_agent_license_repair.mjs <出力sql> <結果json>...` — 上の結果から本番修復SQLを生成（人が読んでから流す）
- `node scripts/audit_agent_company_names.mjs <会社名json>` — 既存の会社名を今の検閲に通し直して壊れている行を出す
- `node scripts/archive_local.mjs [--dry-run] [--dir <保存先>]` — 本番の控えをローカルに増分で貯める（既定 `~/akinavi-archive`）
- `node scripts/archive_query.mjs summary|daily|company|dup|resume|missed|rate|skillfilter` — **控えを集計する。本番を引かない**。
  人材は7日で消えるので、過去との比較はこちらで行う（egress ゼロ）
  - `rate [スキル]` — 経験年数帯ごとの希望単価の分布（25%/中央/75%）。スキル名を付けるとそのスキルだけ。
    スキル×帯で20人に届くセル数も出す（相場をどの粒度で出せるかの根拠）
  - `company [社名]` — その会社のメール1通あたりの人数（**名簿かどうか**）。件名＋受信時刻で束ねる
  - `dup [--since] [--list N] [--company 社名] [--window 7] [--detail]` — **同じ人が増えていないか**。
    本番の仕様（同社の再送は UPDATE で統合・別会社は分けて残す）で分類し、
    **「同じ会社・保持期間の窓の中で増えた」分だけ**を取りこぼしとして数える。
    会社名の正規化は本番の `normalizeAgentCompany` を import する
    ⚠ `duplicate_flag` では測れない。本番はこのフラグを**意図的に使っていない**
    （true にすると `fetch_candidates_for_project` の絞りでマッチングから消える）。
    控えの実測でも 8,279行すべて false。「印が無い＝取りこぼし」は**何も測っていない数字**
    ⚠ 控えは prod（7日保持）より長い履歴を持つので、`--window` で切らないと
    **消えた後の再登録**を取りこぼしに数える（切らないと 190組、切ると 24組）
  - `resume [--since YYYY-MM-DD] [--list N]` — **氏名と経歴書ファイル名の一致**。判定は本番と同じ
    `isOwnersResumeFile`。「一致しない」を「他人の経歴書」と読まないこと（ファイル名に名前が
    入っていない・Drive 共有リンク・イニシャルだけの部分一致を分けて出す）
  - `skillfilter [スキル,...] [--sample N] [--since YYYY-MM-DD] [--no-dot]` —
    優先スキル絞り込みで、**本文の正規表現マッチが `skills` 配列に足している人数**。
    `--sample N` で実物（氏名・`skills` 列・当たった前後の本文・**本文の共有人数**）を見る
  - ⚠ **控えは prod より長い履歴を持つので、`--since` で切らないと結論が逆になる。**
    複数人メールで本文を全員ぶん保存していた問題は **2026-09-17 に修正済み**
    （自分のブロックだけを保存する）。切らずに測ると直った後も壊れて見える
  - ⚠ **語境界は `src/lib/skillWordMatch.ts` と同じ集合でなければ測れない。**
    2026-10-04 まで `._` を語扱いしており、実際より少なく出ていた（PHP 312人→100人）。
    「同じ規則」とコメントだけ書いて中身が違うのが一番危ない
  - ⚠ **本文の正規表現述語は外さない（2026-10-04 に測り直して確認）。** 本文だけで当たるのは
    全期間で 8,215人中223人。**内訳は「ほぼ全部が過去の不具合の残骸」**:
    - 217人 … 複数人メールで本文を共有していた古い行（1通に最大18人）。
      他人のスキルに当たっていただけ＝**取りこぼしではない**（2026-09-17 修正済み）
    - 2026-09-18 以降は**2人だけ**。どちらも送信元がスペースの代わりに `_` を使う本文
      （`【スキル】Java_5年8ヶ月`）で、`skill_master` 照合が `_` を語の一部として扱い
      当たっていなかった → 2026-10-04 に `skillTermPattern` を修正
    つまり述語は「今はほぼ誰も足していないが、**抽出が壊れた瞬間に効き始める保険**」。
    だから残す。効き始めたら夜間健診の検出器⑥（`skill-filter-gap`）が鳴る。
    pg_trgm 索引は DB が 500MB 制限の48%なので足さない
  - ⚠ **2026-10-03 まで、このスクリプトは全部 0 件を返していた。** `archive_local.mjs` が
    `db/<表>/` の下に掘るようになったのに追従しておらず、`existsSync` が false で
    **静かに空を返して終了コード 0** だった。読んだ人は「控えにデータが無い」と判断して prod に
    SQL を投げる＝この道具が防ぎたかったこと。今は見つからなかった表を最後に必ず表示し
    **終了コード 2** を返す。`0件` を見たら、まず終了コードを確認すること
- `node scripts/selfcheck/run.mjs` — **夜間健診。リポジトリのソースとローカル控えだけを読む
  （egress ゼロ・トークンゼロ）**。検出器6本（使われない機械 / 約束だけのフラグ /
  握りつぶされたエラー / 参照エラー / 氏名として成立していない人材 /
  優先スキルが本文にあるのに skills 列に無い人材）。
  終了コード 0=新規なし / 1=新規あり / 2=検出器が落ちた。毎日 04:40 にタスクで回る
  （登録は `powershell -File scripts/register_selfcheck_task.ps1`）
  - 所見は断定ではなく質問。違ったら `--accept "理由" --fp <指紋の一部>` で
    **1件ずつ理由を書いて** `baseline.json` に入れる（まとめて入れると根拠が混ざる）
  - ⚠ **黙らせても永久ではない。** 受け入れ時の最終発生時刻を `seenAt` に残し、
    それより新しい発生があれば「⚠ **再発**」として再び鳴る
- `npx supabase db query --linked -f scripts/sql/quality_check.sql` — **品質チェック（結果だけ返す版）**。
  **3.4KB**で済む。`npm run quality`（quality_check.mjs）は判定のために raw_profile を
  丸ごと引いており**1回7MB**（繁忙日15〜20MB）かかるので、日常の確認はSQL版を使う。
  実際の値を見たいときだけ `quality_check.mjs --fetch-body` か、ローカル控えを使う

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
| `candidates` | 人材マスタ。`data_env`（`prod`/`demo`）で論理分離。主要カラム: `box_url`, `resume_url`, `drive_url`, `desired_rate`, `from_company`, `duplicate_flag`, `merged_into`, `candidate_no`（人が読める通し番号・画面では `AK-000123`。絞り込みの「氏名 / 人材番号」欄に入れると1件で引ける。**再送の UPDATE では維持されるが、保持期間を過ぎて消えた後の再登録では新しい番号になる＝実測で約2%**。`src/lib/candidateCode.ts` と DB 側 `filter_candidates` の判定を**同じ規則に保つ**こと） |
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
| `agent_companies` | 派遣・紹介会社（メール送信元ドメインが主キー）。人材画面「会社管理」で編集。`license_status` は `unknown`（社名が取れず未照合）/ `haken` / `shokai` / `both` / **`notfound`（厚労省サイトで引けなかった＝免許が無いとは限らない）** / `none`（人が免許なしと確認）。`fetch_candidates_for_project` の `p_require_haken` は `haken`/`both` だけ通すので、判定を間違えるとその会社の人材が派遣案件から丸ごと消える |

### app_config の主要キー

**2026-09-16 に実際の行と突き合わせて更新した。** 「現在値」は同日の prod 実測。
未作成のキーは画面で初めて保存したときに作られ、それまではコード側の既定で動く。

| キー | 既定 | 現在値 | 内容 |
|---|---|---|---|
| `inbound_project_enabled` | `false` | （未作成） | 案件メールの解析・DB保存を有効化 |
| `inbound_relevance_check` | `true` | （未作成） | 無関係メール（フィッシング・広告）の事前判定。**`false` で止められる**。2026-10-03 に実装（それまでコメントだけ存在し、実装が無かった）。読めなかったときは有効のまま＝判定を落とす方向に倒さない |
| `auto_match_enabled` | `true` | **`false`** | `auto-match` cron を有効化。**今は止まっている**（直近7日の submissions は9件） |
| `email_poll_mode` | `incremental` | `incremental` | `incremental`（未読のみ）/ `full`（指定日以降全件） |
| `email_use_ai_classification` | `false` | **`true`** | poll-email 内の Gemini メール種別分類。**`email_classify_enabled` は誤記**（そのキーを読むコードは無い） |
| `sender_daily_limit` | `200` | （未作成） | 1送信元あたり1日の取り込み上限。**0以下で無制限**。2026-09-16 に 50 から引き上げ（下記） |
| `storage_retention_days` | `7` | `7` | 添付の保持日数 |
| `storage_quota_bytes` | 1GB | `1073741824` | Storage の上限（Free プラン） |
| `storage_alert_pct` | `70` | `70` | この割合を超えたら警告 |
| ~~`raw_retention_days`~~ | — | `1` | **もう読むコードが無い**（2026-09-17 削除）。`raw/` への保存は 2026-09-14 に廃止済みで、実測でもオブジェクト0件だった。行は残っているが無視してよい |
| `matching` | — | `top_n:5, min_score:60` | AI採点する上位件数と足切りスコア |
| `matching_run_mode` | `fast` | （未作成） | `fast` / `full`。SettingsPage から変更可 |
| `matching_fast_max_candidates` | `20` | （未作成） | 高速モード時の案件あたり候補者上限 |
| `matching_fast_max_projects` | `10` | （未作成） | 高速モード時の人材あたり案件上限 |
| `candidate_retention_days` | `7` | （未作成） | 人材データ保持日数 |
| `own_email_domain` | — | `i-voice.co.jp` | 自社ドメイン（送信元を所属会社にしないため） |
| `app_memo` | — | — | 営業引き継ぎ用フリーテキスト |
| `app_base_url` | `https://akinavi-hr-ai-aws.vercel.app` | （未作成） | 通知メールに入れる人材リンクの宛先。`?c=<uuid>` を付けて送る（`notify-candidates`）。別URLで運用するときだけ入れる |

#### ⚠ 制限を入れるときは「何を守るためか」を書く（2026-09-16 の教訓）

`SENDER_DAILY_LIMIT = 50` は 2026-05-19 に「一斉配信業者による **AIコスト急騰対策**」として
入れたが、**その翌日 2026-05-20 に inbound-email から AI解析を完全除去**している（139a4f2）。
守る対象が消えたまま4か月動き続け、直近7日だけで人材メール458件を捨てていた
（i-standard.jp 332件＝1日66件）。

今の本当の制約は **Storage（Free 1GB）** だが、保持7日で自動的に頭打ちになる
（実測: attachments 1,993ファイル 305MB、最古がちょうど7日前＝掃除は効いている）。
そこで `app_config.sender_daily_limit`（既定200）に移し、デプロイ無しで絞れるようにした。

**制限値には「何を守るか」と「測った数字」をコメントに残すこと。**
理由が書いていないと、前提が消えても誰も気付けない。

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
- **通知機能**: `notification_rules` に合致する人材が登録・更新されたら `notify-candidates`
  Edge Function が Graph sendMail でメール通知。二重通知は `notification_log` で防止。
  送信には Mail.Send スコープ（Microsoft再連携）が必要。
  **cron は毎時（`notify-candidates-hourly` / `0 * * * *`）。5分間隔ではない**
  （2026-10-03 に `cron.job` を実測。CLAUDE.md は「5分」と書いていた）。
  絞り込み条件は 2026-10-01 に拡張した（`20261001_notification_rule_filters.sql`）:
  年齢の上下限・経験年数の下限・スキル年数の下限・到達レベルCの除外・本文キーワード（OR）・
  値が取れていない人材を通すか（`include_unknown`・既定 true）。
  **`include_unknown` を false にすると取りこぼす**（skillYears は31%、到達レベルは49%が未取得）。
  2026-10-12 に**商流・雇用形態の選択条件**を足した（`20261012_3_notification_rule_employment.sql`）:
  `commercial_flows`（自社/1社先/2社先以降）と `employment_types`
  （フリーランス/正社員/契約社員/派遣社員/業務委託）。軸の中は OR・軸どうしは AND。
  「自社正社員」は 商流=自社 × 雇用形態=正社員（prod 実測352人）で表す。
  取得率は雇用形態82.6% / 商流85.0% なので、未取得の扱いは `include_unknown` に従う。
  選択肢は画面（`src/lib/db/notificationRules.ts`）と Edge Function（`match.ts`）の2か所にあり、
  ズレ検出は `src/lib/__tests__/notificationRuleOptions.test.ts`。
  **手動の試し送信**ができる（`node scripts/invoke_notify.mjs --test [--dry]`）。
  本番と同じ判定・同じ本文で送り、`notification_log` もウォーターマークも動かさない
- **認証なし**: ニックネームを `localStorage` に保存
- **表示優先スキル**: 既定は `app_config.llm_filter_skills`（設定画面「AI校正の優先スキル」＝常駐AIの解析対象と共有）。
  人材画面の絞り込みポップアップから**端末ごとに上書き**でき、ON/OFF と中身を `localStorage`
  （`akinavi.prioritySkills.v1`）に保存する。ロジックは `src/lib/prioritySkillPref.ts`。
  認証が無くユーザーを識別できないため端末単位。AI校正バッジ（`aiCorrectionStage`）は
  ワーカーの実際の対象を表すので**端末設定ではなく app_config の値**を使う
- **人材マップの絞り込みと並び替え（2026-10-20）**: スキル・期間に加えて
  **所属（商流×雇用形態）/ すぐ稼働OK / 経歴書あり**で絞れる。並びは
  新しい順・古い順・稼働が早い順・単価が安い/高い順・経験が長い順。
  選択肢は `src/lib/heatmapFilters.ts` と `src/lib/heatmapCandidateSort.ts`、
  実体は `20261020_2_heatmap_affiliation_filter.sql`（商流の丸めは SQL の `flow_bucket()`）。
  - **絞り込みは地図の色・ランキング・一覧の3つ全部に効かせる**。一覧だけに効かせると
    「50人」と塗られた県を開いて3人しか出ず、どちらが本当か画面から判断できない
  - **並べるのは必ず DB 側**。RPC は先頭10件しか返すので、画面で並べ替えると
    「古い順」が *新着10件を古い順に並べたもの* になる（母集団が変わる）
  - ⚠ **未取得の人の扱いが画面ごとに違う。** 人材マップと人材タブは
    商流・雇用形態が取れていない人を**通さない**（曖昧な絞りは意味が無い／その場で解除できる）。
    通知ルールは逆に `include_unknown`（既定 true）で**通す**（取りこぼすと二度と届かない）。
    マップには「未取得の人は出ません」と画面に出すこと（黙って減らすと取りこぼしに見える）
  - ⚠ **`candidates_archive_light` は所属・稼働時期・経歴書・経験年数の列を持たない。**
    全期間表示でこれらを絞るとアーカイブ側は一人も通せない（実測: 絞りなし23,772人 →
    自社正社員342人＝live のみ）。絞ったら除外して注記を出す
  - 選択肢に**入れなかったもの**: `2社先以降`(本番4人)・`派遣社員`(14人)・`業務委託`(10人)。
    県で割ると必ず0人になるボタンは置かない（星を並びに入れなかったのと同じ判断）。
    RPC は値を受け取れるので、必要になれば画面側に1行足すだけでよい
- **人材を直接開く URL（2026-10-20 営業の要望「人材詳細の全部の箇所に」）**:
  `src/components/CopyCandidateLinkButton.tsx`。形は通知メールのリンクと同じ `?c=<uuid>` で、
  組み立ては `candidateLinkUrl`（`src/lib/candidateCode.ts`）に1本化してある。
  受け側（App.tsx）は uuid から `data_env` を引いて表示環境ごと合わせるので、
  リンクに環境もデモキーも付けない。
  - 置き場所は**人材詳細の3か所全部**（`CandidateDetailPage` / 人材タブの詳細ペイン /
    マッチングの人材ペイン）。置き忘れても他の2つで動くので気づけない。
    呼び出し側の存在は `CopyCandidateLinkButton.test.tsx` がソースを読んで固定する
  - ⚠ **URL に入れるのは uuid だけ。** 氏名・メールは貼り先（チャット・メール・プロキシ）に
    URL ごと残る。人材番号も使わない（保持期間後の再登録で変わる＝実測約2%）
  - ⚠ **コピーできたかを必ず画面に出す。** `navigator.clipboard` は https でない社内 IP や
    一部の WebView で使えないので、旧 API を試し、**それでも駄目なら URL を入力欄に出して
    手でコピーさせる**（`src/lib/copyToClipboard.ts` が成功/失敗を返す）。
    黙って「コピーしました」と出すと、貼ったつもりの空文字が相手に届く
  - 宛先は `app_config.app_base_url` ではなく**今開いている画面の origin**
    （社内の別 URL で使っている人がコピーしても、その人が開けた URL のまま渡せる）
- **人材一覧の印（2026-10-19 に作り直した）**: 人材タブの氏名の隣に出る印。
  - **「上位候補: <案件名>（N位）」** … `top_match_marks` が元。公開中の案件それぞれの
    **今の上位5人**を `refresh_top_match_marks()` が計算する。順位は
    `fetch_candidates_for_project` をそのまま呼ぶので**マッチング画面と必ず一致する**
    （配点の2重定義を作らない）。上位5人にしたのは実測の密度から
    （3位まで33人 / 5位まで56人 / 10位まで101人 / 20位まで189人・母数1,729人）。
    人数を変えるときは `app_config.top_match_rank_limit` を書き換えて refresh を1回呼ぶ。
    印は人材・案件が消えれば ON DELETE CASCADE で道連れに消える
  - **計算のきっかけは「人材が届いたとき」**（2026-10-20 ユーザー指示
    「1時間でやり直しとかしなくてもいい。人材が届いた際の判断のみで」）。
    cron `top-match-marks-on-arrival`（`*/10 * * * *`）が
    `refresh_top_match_marks_if_new()` を呼び、**前回の計算より後に届いた人材
    （`created_at`）か、変更された公開中の案件が無ければ -1 を返して何もしない**。
    ⚠ 1人ぶんだけ計算する入口は作れない。`fetch_candidates_for_project` は
    「案件の上位N人」しか返さず、1人のスコアを返す口が無い。1周の値段は人数に
    関係なく一定（本番実測40秒／open案件15件・充足数の計算込み）なので、
    **まとめて1回まわすのが一番安い**。到着ごとに回すのは不可能
    （実測で 10/19 は942人・1人ずつなら9時間）。遅れは最大10分
    ⚠ `updated_at` は見ない。常駐AIの校正で動くので、人が届かなくても回り続ける
    ⚠ 24時間まわっていなければ到着が無くても1度まわす（消えた人の印が
    CASCADE で減るだけになるのを防ぐ）
  - **印に根拠を添える**: `top_match_marks.skill_hit / skill_total` に
    「必須9件中6件」を入れている（2026-10-20）。順位だけでは
    「本当にこの案件に合っているのか」が画面から確かめられず、疑われた
    （実際は合っていた）。数えるのは `skill_hit_weights` に重み無しで
    ＝マッチングと同じ判定。本番実測で75行 4.6秒
  - **「決定 / 提案済 / 見送り」** … `submissions` が元。**人が動かしたときだけ**出す。
    動かす場所は**マッチング結果の行**（2026-10-20・#191）。決定は［この人に決定］、
    提案済・見送りは行の［提案済にする］［見送りにする］。もう一度押せば取り消し（pending に戻す）。
    遷移の判定は `src/lib/submissionAction.ts` の1か所（テスト付き）で、書き込みは
    `updateSubmissionStatus`。⚠ 「決定」だけは同一人材の他案件を一括で見送りにする
    （二重決定の防止）。印の付け外しは**その1件しか触らない**
    ⚠ 2026-10-20 まで `sent`/`rejected` に**到達できなかった**（prod 117件すべて pending）。
    進める導線が `src/pages/HistoryPage.tsx` にしか無く、そのページはナビが5タブに
    なった時点でどこからも import されていなかった。同日に HistoryPage は削除した
  - **「通知済 M/D」** … `notification_log` が元（2026-10-20 要望「メール通知で送った印」）。
    この表は service_role 専用なので、宛先 `sent_to` を落としたビュー
    `notification_marks` だけを anon に公開して読む。
    ⚠ 記録は人材より長生きする（FK を張っていない）。本番実測で246件のうち
    今いる人材に当たるのは16人だけ。印が少なく見えてもそれが実態
  - ⚠ **`submissions.status='pending'` は印にしない。** この行はマッチングを実行すると
    候補に挙がった人**全員**に自動で作られる（`upsertSubmissions`）ので、
    「提案候補」と書くと人が選んだように読める。しかも過去の実行ぶんが積み上がり、
    上位20人しか保存しない案件に31件・28件 溜まっていた（2026-10-19 実測）。
    詳細画面にだけ「過去にマッチングを実行した案件」として残す
  - どの印を出すかの判定と文言は **`src/lib/submissionBadge.ts` の1か所**。
    一覧カードと絞り込み一覧の2か所で描くので、ここが分かれるとズレる
- **重複管理**: email一致で自動UPDATE。名前一致 + スキルJaccard ≥ 0.4 で `duplicate_flag=true`。
  同名照会は**最寄駅一致を先に引く**（イニシャル氏名は同名が多く、prod実測で同名10件超の氏名が52種・
  最大35件。無作為な上限で本人を取り逃すと毎日二重登録される・2026-08-21）
- **役割の定義**: **`docs/ROLE_DEFINITION.md` が正**（2026-09-01）。
  役割は「ラベル」ではなく **作用対象 × 権限 × 到達レベル** の3軸で定義する。
  根拠は SFIA / IPA ITSS・情報処理技術者試験の対象者像 / 日本PMO協会 / PMI / Scrum Guide。
  - `role_affinity` は2軸の式（`20260901_role_taxonomy.sql`）。PM×PMO は 0.2（対象も権限も最遠）
  - 到達レベル（A主導/B担当/C従事/－裏付けなし）は `scoreProseRoles` が regex で判定し
    `raw_profile._roleLevels` に入る。**実測で希望単価が単調に分かれた6役割にだけ付ける**
    （PMO・PM・コンサルタント・アーキテクト・テックリード・インフラ）。
    分かれない役割に印を付けない。意味のない印は害になる
  - **役割は消さない。印を付けて営業に見せる**（消すと根拠が確認できない）
  - 触る場所は4か所: 上記SQL / `match-batch` の `ROLE_AXIS` / `inbound-email` の `ROLE_DEFS` /
    `project_apply.mjs` の `ROLE_LABELS` と `prompts.mjs`。
    ズレ検出は `src/lib/__tests__/roleAffinityParity.test.ts` と `scripts/sql/test_role_affinity.sql`
- **役割・業界の抽出**: `extractFromProse`（`supabase/functions/inbound-email/index.ts`）。
  経歴書は「業界を書いた文書」ではないので、**裸の一般語（大学・通信・公共・広告・HR・メーカー）は使わない**。
  業界は出現回数でスコア付けし上位 `INDUSTRY_MAX`(=4) 件だけ残す。役割は**上限なし**
  （マッチングが 同一+15/同系統+6/系統違い-9 で採点するため、削ると減点に化ける）。
  英字略称（SE/PG/PM/PL/TL）は必ず `(?<![A-Za-z])…(?![A-Za-z])` で囲む
  （DATABASE→SE・JPG→PG の誤検出実績あり）。品質テスト: `node scripts/test_prose_roles_industries.mjs`

## ⚠ Free プランの3つの壁（2026-09-30 に Pro → Free へ戻した）

1か月だけ Pro を払い、**2026-09-30 に Free へ戻した**（Supabase の変更は即時適用。
残り日数は日割りでクレジットに戻る）。請求サイクルは **毎月30日始まり**。

| 壁 | 上限 | 2026-09-30 実測 | 測り方 |
|---|---|---|---|
| DB | 500MB | 240MB（48%） | `pg_database_size`。**SQL が正** |
| Storage | 1GB | 524MB（51%） | `storage.objects` の合計。**SQL が正** |
| egress | 5GB/月 | サイクル開始直後で0 | **DB からは測れない。ダッシュボードが正** |

```bash
node scripts/free_plan_watch.mjs      # DB と Storage の現在地・増え方・上限到達までの日数
```

終了コード 0=余裕 / 1=警告(70%) / 2=危険(85%)。履歴は `~/.akinavi_free_plan_state.json`。
egress は同スクリプトが出す URL をブラウザで開いて確認する（組織側の usage ページが正）。

超えたときに起きるのは**本番が読み取り専用・応答不能**＝営業が使えなくなること。
詰めるときは **掃除の間隔から先に**。保持日数を削るのは業務影響があるので独断で決めない。

## ⚠ Egress を使わずに検証する（2026-08-14 ユーザー指示）

**実装・テスト・検証で本番からデータを引かない。egress はユーザーが画面で確認する分に取っておく。**

Free Plan の egress 5GB に対し 8/14 時点で 2.98GB 消費・残り9日、
ダッシュボードに「Grace period is over（枠を使い切るとリクエストを返せなくなる）」が出ていた。
8/13 単日 822MB のうち **94% が PostgREST**（ブラウザとスクリプトの DB 読み取り）。
その後の削減が効き、Pro 期間（8/30〜9/30）の実測は **月2.39GB**＝Free の 5GB には収まる水準。

### ⚠ 調査は「ローカル控え」から始める。prod への SQL は最後の手段（2026-10-03 指摘）

**「集計は SQL 側で」は prod に投げてよいという意味ではない。** 順番は常にこう:

1. **`node scripts/archive_query.mjs ...`（ローカル控え・egress ゼロ）** ← まずここ
2. 控えに無い切り口なら **`archive_query.mjs` にサブコマンドを足す**（その場限りのクエリを書かない）
3. 経路として動くかを見たいなら demo（53件）
4. **prod への SQL は「今この瞬間の prod にしか無い事実」だけ**（枠の使用量・cron の状態など）

やらかした例（2026-10-03）: 通知メールに同じ人が2回出た件で、いきなり
`supabase db query` を prod に投げた（型エラーで2回）。人材データは控えに
貯まっているので**全部ローカルで出せた**。しかも控えは7日で消える prod より
**長い履歴を持っている**ので、そちらの方が正しい道具だった。

人材・会社・日次の分布や重複など「データの性質」を見たくなったら、手が
`supabase db query` に伸びる前に `archive_query.mjs` を見ること。

| やらない | 代わりに |
|---|---|
| **データの性質を調べるために prod へ SQL を投げる** | **`node scripts/archive_query.mjs`（ローカル控え）**。足りなければサブコマンドを足す |
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
