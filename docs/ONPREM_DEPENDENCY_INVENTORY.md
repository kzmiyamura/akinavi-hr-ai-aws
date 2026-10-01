# Supabase / Vercel 依存の棚卸し（2026-10-01）

**目的**: 「今のバージョンはそのまま動かしたまま、ローカルでも同じものを作り、
徐々に Supabase と Vercel が無くても動くようにする」ための地図。

**この調査では本番に一切書き込んでいない。** 読み取り（SQL の集計と `select ... limit 1`）と
ソースの grep だけ。

---

## 0. 結論を先に

**技術的な移植は思ったより軽い。重いのは運用と商用化の方。**

| | 評価 | 理由 |
|---|---|---|
| DB・API・Storage・Edge Functions | **ほぼそのまま移る** | Supabase はセルフホスト可能。同じ Postgres・同じ PostgREST・同じ Deno ランタイムが docker compose で立つ。マイグレーション137本と Edge Function 14本はそのまま流用できる |
| Vercel | **置き換えは簡単** | 実質「静的ファイルの配信」だけ。下の §4 参照 |
| **AI（マッチング・校正）** | **ここが一番重い** | §5。売り物にするなら作り直しが要る |
| **メール取り込み（Microsoft Graph）** | **顧客ごとの作業が要る** | §6 |

---

## 1. フロントエンド（React / Vite）

- `src` は 134 ファイル。**Supabase クライアントを直接 import しているのは 9 ファイルだけ**で、
  残りは `src/lib/db/*`（13 モジュール）経由。差し替え口は狭い
- 使っている supabase-js の機能: `.from()` 105 / `.rpc()` 20 / `.functions.invoke()` 7 /
  `.channel()` **1** / `.storage` 0 / 認証 **0**
- **認証を使っていない**（ニックネームを localStorage に置くだけ）。
  オンプレで社内に閉じるなら、むしろこのままの方が素直
- `.channel()` の1件は `MonitorPage` の Realtime 購読。
  **ローカル設定（`supabase/config.toml`）では realtime を無効にしてある**ので、
  ローカルで動かすと監視画面だけ更新が来ない。有効化するか、ポーリングに替える

## 2. データベース

- マイグレーション **137本**。Postgres 17.6
- 拡張: **pg_cron**（定期実行）と **pg_net**（SQL から HTTP を投げる）。どちらも
  セルフホストの Supabase イメージに入っている
- RPC（フロントが直接呼ぶ SQL 関数）は 18 本:
  `fetch_candidates_for_project` / `search_candidates` / `filter_candidates` /
  `prefecture_counts` / `skill_categories` ほか
- マテリアライズドビュー `skill_norm_map`、表 `station_master`（12,666行）など、
  **マスタはすべてマイグレーションと JSON に入っている**ので再現できる

### pg_cron の実体（2026-10-01 実測）

| ジョブ | 設定 | 備考 |
|---|---|---|
| `poll-email-every-5-minutes` | `*/5 * * * *` | メール取り込み |
| `notify-candidates-hourly` | `0 * * * *` | **コードのコメントは「5分間隔」だが実際は毎時**。CLAUDE.md も要修正 |
| `cleanup-storage-daily` | `0 * * * *` | **名前は daily だが実際は毎時**（容量対策で間隔を縮めた経緯） |
| `auto-match-daily` | `0 0 * * *` | `app_config.auto_match_enabled=false` で停止中 |
| `archive-candidates-daily` | `0 15 * * *` | JST 0:00 |
| `enrich-candidate-daily` / `skill-master-cleanup-daily` / `hf-spaces-quality-check` | `0 18 * * *` | JST 3:00 |
| `ailogs-cleanup-daily` / `verify-agent-license-daily` | `0 17 * * *` | |
| `cron-history-cleanup-daily` | `30 17 * * *` | |
| `hf-spaces-keepalive` | `0 * * * *` | Hugging Face Spaces のスリープ防止 |

**ジョブ名と実際の間隔が食い違っているものが2つある。** 移すときは名前ではなく
`cron.job` の実体を正とすること。

## 3. Storage

- バケットは **`attachments` 1つだけ**（経歴書などの添付）。524MB・3,404ファイル・保持7日
- フロントからは直接触っていない（`.storage` の参照が0件）。読み書きは Edge Function 側
- **オンプレならただのファイルシステムで足りる。** ここは一番移しやすい

## 4. Vercel

実質やっているのは3つだけ。

1. **静的ファイルの配信**（`dist/`）→ nginx / Caddy で置換可能
2. **SPA の rewrite**（`assets/` と `docs/` を除いて `/` に寄せる）→ 同上。
   `assets/` を除外している理由はビルド後のチャンクを 404 で見せるため（CLAUDE.md 参照）
3. **`api/analyze.ts`（Serverless Function・412行）**
   - Make.com → Gemini 解析 → Supabase 保存の旧経路
   - **リポジトリ内に呼び出し元が1つも無い**（参照は `vercel.json` の設定のみ）
   - 最終更新 2026-05-23。現在のメール取り込みは Graph ポーリング＋`inbound-email` で、
     AI は使っていない
   - → **死んでいる可能性が高い。** 移植前に「本当に外から叩かれていないか」を
     Vercel のログで確認し、使われていなければ消すのが先

ビルドは `tsc -b && vite build`。これはどこでも動く。

## 5. AI ─ ここが商用化の最大の壁

| 用途 | 今の実装 | オンプレ・販売時の問題 |
|---|---|---|
| 人材の校正（本番稼働中） | **このPCの常駐ワーカーが `claude -p`（Max サブスク）で実行** | **売り物にできない。** 個人のサブスク枠に依存している。顧客ごとに API キーか別の手段が要る |
| マッチング採点 | Cerebras `llama3.1-8b` → Groq → Gemini の3段フォールバック | 外部APIなので「情報漏洩が心配」という動機と**正面から衝突する**。経歴情報が社外に出る |
| 画面のファイル解析 | Gemini `gemini-2.5-flash-lite` | 同上 |
| メール解析 | **AI不使用**（regex ＋ `skill_master` 照合） | 問題なし。むしろ強み |

**オンプレの売り文句が「情報漏洩対策」なら、AI を外部APIに投げている限り成立しない。**
選択肢は (a) ローカルLLM を同梱する (b) AI機能を切れるようにする
(c) 顧客のAPIキーを使わせる、のどれか。**ここは技術ではなく商品設計の判断。**

なお **メール解析が AI 不使用**なのは効いている。取り込みの根幹は外部に何も出していない。

## 6. 外部サービス（Edge Function から呼んでいる先）

| Function | 外部先 | オンプレ時 |
|---|---|---|
| `poll-email` / `notify-candidates` / `microsoft-oauth` | Microsoft Graph | **顧客ごとに Azure アプリ登録と管理者同意が要る。** 導入手順書が必須 |
| `match-batch` / `match-score` | Cerebras / Groq / Gemini | §5 |
| `inbound-email` / `enrich-candidate` | Google Drive / Sheets | Box・スプレッドシート連携。顧客が使わないなら切れる |
| `verify-agent-license` | 厚労省 人材サービス総合サイト | 日本国内向けなのでそのまま使える |
| `hf-proxy` | Hugging Face Spaces | 品質チェック用。オンプレでは外せる |
| `create-github-issue` | GitHub API | 開発用。製品には不要 |

必要な Secret は13種:
`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` /
`GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / `CEREBRAS_API_KEY` / `GROQ_API_KEY` /
`GEMINI_API_KEY` / `GOOGLE_SERVICE_ACCOUNT_JSON` / `BOX_SPREADSHEET_ID` /
`HF_API_SECRET` / `GITHUB_TOKEN` / `INBOUND_MAKE_SOFT_FAIL`

**AI と Google と HF と GitHub を外すと、残るのは Supabase 3つと Graph 2つだけ**になる。
最小構成のオンプレ版はここを目指すのが素直。

## 7. 今すぐ動かすのに足りないもの

- **このPCに Docker が入っていない。** セルフホスト Supabase（`supabase start` も同じ）は
  Docker が前提。導入はユーザー判断
- `supabase/config.toml` は既にローカル用に書いてある（ポート 5433x、studio と
  realtime と analytics は無効）。**ローカルで立てる下地はもうある**
- ローカル控えは **D:\akinavi-archive**（mail 7.0GB / db 151MB / masters 31MB）。
  種データには困らない

## 8. 次の一手（案）

1. `api/analyze.ts` が本当に死んでいるかを Vercel のログで確認し、死んでいれば削除する
   （Vercel 依存が「静的配信だけ」に落ちる）
2. Docker を入れて `supabase start` → マイグレーション適用 → 種データ投入 →
   `npm run dev` で**ローカル一式が動くこと**を確認する
3. そこで初めて「AI をどうするか」を決める（§5）。ここが決まらないと製品にならない

---

**注意**: この文書は 2026-10-01 時点の実測。
CLAUDE.md の「正の所在: 仕様はソースコードが正」はここにも当てはまる。
着手前に grep と実測で確かめ直すこと（[[handoff-tasklist-goes-stale]] と同じ轍）。
