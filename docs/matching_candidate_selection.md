# マッチング候補者選定ロジック

`src/pages/MatchingPage.tsx` / `supabase/functions/match-batch/` / `auto-match/` / `match-score/` / `supabase/migrations/20260525_*.sql` / `20260526_*.sql` / `20260527_fix_kyoto_bug.sql` の実装に基づく。

---

## 概要

AI 呼び出しを 1 案件 = 1 コールに圧縮するため、コミット `b35df40` で **ルールベース事前フィルタ + バッチプロンプト** 方式を導入し、Phase 4.13（コミット群 `4d893bd`〜`20c2bfd`）で **ルールスコア計算を SQL 側に全面移植・ウェイト可変化・同一地方加点** を実装した。

```
全候補者
  └─► RPC fetch_candidates_for_project（SQL 側でルールスコア計算済み・上位 500 件）
        └─► duplicate_flag=true と merged_into!=null は SQL 側で既に除外
              └─► match-batch Edge Function
                    ├─ calcRuleScore で再採点（topN 選定用・SQL と一致）
                    ├─ 上位 topN（既定 10 名）だけ AI にバッチ採点を依頼
                    │     ├─ Cerebras llama3.1-8b（プロンプト 22500 文字以下のみ・20s）
                    │     ├─ Groq llama-3.3-70b-versatile（25s）
                    │     └─ Gemini gemini-2.5-flash（30s）
                    │           └─ 全段失敗時はルールスコアで全代替（usedModel='rule'）
                    ├─ AI スコアは ruleScore ±15pt 以内に丸める（ハルシネーション抑制）
                    └─ 残り（ruleOnly）はルールスコアのみで返す
```

> `skill_master` の正規化テーブルでスキルの表記ゆれ（React / React.js / ReactJS など）は内部で同名扱いされる。
> `auto-match`（毎朝 JST 9:00 cron）は `match-batch` を内部呼び出しするため、同じフォールバック順を継承する（**Gemini 単発はもう使われない**）。

---

## 候補者取得 RPC

### `fetch_candidates_for_matching(p_data_env, p_limit DEFAULT 2000)`

`20260525_fix_matching_rpc_duplicate_filter.sql` で `p_limit` を 800 → 2000 に拡大、`duplicate_flag=true` と `merged_into!=null` を **SQL 側で除外**。

- `WHERE data_env = p_data_env AND merged_into IS NULL AND duplicate_flag = false`
- `ORDER BY created_at DESC, COALESCE(experience_years, 0) DESC`
- LIMIT 2000

### `fetch_candidates_for_project(...)`（Phase 4.13 で大幅拡張）

`20260527_fix_kyoto_bug.sql` が現行版。**ルールスコアを SQL 側で計算してから上位 500 件を返す**。

#### 引数

| 引数 | 既定 | 内容 |
|---|---|---|
| `p_data_env` | — | `prod` / `demo` |
| `p_required_skills` | NULL | 必須スキル配列（lower + trim 正規化済み配列内部に変換） |
| `p_budget_min` / `p_budget_max` | NULL | 予算範囲 |
| `p_work_location` | NULL | 勤務地（都道府県の接尾辞までを `regexp_match('^([^\s\u3000]+?)[都道府県]')` で抽出） |
| `p_remote_policy` | NULL | リモート方針テキスト |
| `p_limit` | 500 | 取得上限 |
| `p_weight_skill` / `p_weight_exp` / `p_weight_rate` / `p_weight_location` / `p_weight_remote` | 40/15/15/20/10 | **各観点のウェイト**（実行時に変更可能） |

#### 内部処理

1. `set_config('statement_timeout', '30000', true)` で 30 秒に延長
2. 案件側の都道府県コア・地方・フルリモート判定を **一度だけ計算**（`v_work_pref_core` / `v_work_region` / `v_is_full_remote`）
3. `CROSS JOIN LATERAL` で各候補者の `hits`（スキル一致数）・`rate_val`（万単位の単価）・`pref_core`（候補者の都道府県コア）を計算
4. **2 つ目の `CROSS JOIN LATERAL`** で 5 観点をルール計算 → `rule_score`
5. `ORDER BY rs.rule_score DESC, c.created_at DESC` + `LIMIT p_limit`

> CROSS JOIN LATERAL が 2 つあるのは、ルールスコア計算を 1 回だけにしてタイムアウトを解消した経緯（`20260526_fix_timeout.sql`）。

---

## ルールベーススコア配点（SQL 側 / 既定ウェイト 100pt）

| 観点 | 既定ウェイト | ロジック |
|---|---|---|
| **スキル一致** | 40pt | `required_skills` が指定されているとき: 完全一致 `pre.hits` / `v_skills_len` × 40pt。必須未設定時は `0.5 × 40 = 20pt`。歓迎スキルは `match-batch` 側で + 0.1 ボーナス（最大 40pt キャップ） |
| **経験年数** | 15pt | 10年=15 / 7年=12 / 5年=8 / 3年=4 / 1年=2 / **不明=5**（Phase 4.13 で 0pt から中間点 5pt に変更・コミット `0507697`） |
| **単価** | 15pt | 予算未設定 → `1.0 × 15 = 15pt` / 範囲内 +15 / 上限+10% 内 +8 / 上限+20% 内 +3 / それ以上 0 |
| **勤務地** | 20pt | フルリモート +20 / **同一都道府県完全一致 +20**（Phase 4.13 で部分一致から完全一致へ修正・コミット `f866f1b`）/ **同一地方一致 +10**（`get_region` 関数・新規）/ 居住地不明 +5 / 不一致 0 |
| **リモート** | 10pt | `pre.is_full_remote` でない、かつ `remoteAvailable=true`、かつ案件側に `リモート \| remote \| 在宅` を含むとき +10 |

### `get_region` 関数（`20260526_region_location_scoring.sql`）

`IMMUTABLE` SQL 関数。`prefecture_core`（都道府県の接尾辞なし）を地方名にマッピング:

| 地方 | 含まれる都道府県 |
|---|---|
| 北海道 | 北海道 |
| 東北 | 青森 / 岩手 / 宮城 / 秋田 / 山形 / 福島 |
| 関東 | 茨城 / 栃木 / 群馬 / 埼玉 / 千葉 / 東京 / 神奈川 |
| 甲信越 | 新潟 / 山梨 / 長野 |
| 北陸 | 富山 / 石川 / 福井 |
| 東海 | 岐阜 / 静岡 / 愛知 / 三重 |
| 近畿 | 滋賀 / 京都 / 大阪 / 兵庫 / 奈良 / 和歌山 |
| 中国 | 鳥取 / 島根 / 岡山 / 広島 / 山口 |
| 四国 | 徳島 / 香川 / 愛媛 / 高知 |
| 九州 | 福岡 / 佐賀 / 長崎 / 熊本 / 大分 / 宮崎 / 鹿児島 / 沖縄 |

### 京都バグ修正（コミット `f866f1b` / `20260527_fix_kyoto_bug.sql`）

旧版は `LIKE '%pref_core%'` で部分一致していたため、案件勤務地「東京都 大森」に対して候補者「京都府」が誤ヒットしていた。
**対策**: 案件側の `v_work_pref_core` と候補者側の `pre.pref_core` を **完全一致** で判定するように変更。

### スキル全不一致時の上限制限（コミット `eb03686` / Issue #12）

`match-batch` 側で `required.length > 0 && hits === 0` の候補者は **合計 35pt にキャップ**。
スキル全不一致なのに経験年数・単価・勤務地・リモートが満点でも上位に来させない設計。

### Excel `skillYears`（スキル別経験月数）活用（コミット `5f61959`）

Excel スキルシートから抽出された `skillYears: Record<string, number>`（月単位）があれば、必須スキルとの一致で **per-skill の年数** をマッチングに反映。
優先順位:
1. `skillYears` がある → 必須スキルにマッチする月数を年に換算
2. 必須スキルへの「希望」表明（`desiredProject` / `selfPR` / `agentComment` に必須スキル名 + 希望ワード）→ 5年相当（8/15）
3. 総経験年数（`experience_years`）

---

## AI 再採点プロンプト（120 字以内・観点優先順）

`buildBatchProjectToCandidatesPrompt` が生成する 1 コール分のプロンプト。

各候補者には `ruleScore`・`ruleBreakdown`・`matchedSkills`・任意の `summary` / `selfPR` / `agentNote` / `wantedJobs` / `nationality` を渡す。

```
1. score（整数）: 各候補者の score をそのまま使うこと（変更禁止）
2. summary（80〜120字）: 以下のルールで日本語コメント
   - breakdown の内容（スキル合致・経験・単価・勤務地）を自然な日本語で 1〜2 文にまとめる
   - スコア数値・分数は出力しない
   - matchedSkills があれば具体的なスキル名を含める（ない場合は「スキル不一致」）
   - breakdown に「勤務地XX/20」と記載があればその事実のみ書く（「リモート不可」等の推測追記禁止）
   - summary/selfPR/agentNote がある場合は案件との適合を 1 文追加
   - wantedJobs がある場合は案件との合致を 1 文追加
   - nationality がある場合はビザ・日本語要件の確認を 1 文追加
```

出力形式: `[{"id":"...","score":整数,"summary":"120字以内"},...]`

### `filterRelevantSkills`（最大 10 件絞り込み）

候補者のスキル全部をプロンプトに乗せるとトークンが膨大になるため、**必須・歓迎スキルに合致するものを優先**して最大 10 件に絞る。

### AI スコア範囲制限（コミット `d382aac`）

`match-batch` は AI が返したスコアを `ruleScore ± 15pt` 以内にクリップ。AI が極端なハルシネーションを起こしても結果がブレない。

### max_tokens 設定（コミット `522825f`）

- Cerebras: 4096
- Groq: 8000
- Gemini: 8000

20 人分の JSON が途中で切断される問題への対策。Cerebras はプロンプトが 22500 文字を超える場合スキップして Groq へ。

---

## topN・除外ルール

- `duplicate_flag=true` の候補者は **マッチング対象から完全除外**（SQL 側 / Phase 4.13）
- `merged_into != null` も除外（重複マージ済み）
- `accepted` 状態の人材は `auto-match` 側で除外（提案済みのため）
- 既存 `submissions` ペアは `auto-match` 側で除外

---

## 高速モード vs 全件モード vs auto-match

| 観点 | 高速モード（UI） | 全件モード（UI） | auto-match（cron） |
|---|---|---|---|
| 案件→人材の対象件数 | `matching_fast_max_candidates`（既定 20） | `fetch_candidates_for_project` 上限 500 | 案件 1 件あたり最大 40 名 |
| 人材→案件の対象件数 | `matching_fast_max_projects`（既定 10） | 全案件 | 未対応 |
| AI 採点される件数 | topN（既定 10） | topN（既定 10） | topN（既定 10）× バッチ |
| 残り（ruleOnly）の扱い | スコア順表示 | スコア順表示 | submissions に upsert |
| ルールスコア計算 | **SQL 側**（`fetch_candidates_for_project`） | **SQL 側** | **SQL 側** |

上限件数は `app_config.matching_fast_max_candidates` / `matching_fast_max_projects` で変更可能。**マッチング実行モード（`matching_run_mode`）** も `app_config` から保存・SettingsPage で切替可能（Phase 4.14 / Issue #1）。

---

## ai_raw への ruleScore 保存（コミット `ddd3258`）

`submissions.ai_raw` に **AI スコア / ruleScore の両方を保存** することで、AI が ruleScore とどれだけ乖離した判断をしたかを後追いできる。乖離が大きいケースを集計すれば、AI プロンプトの改善や ±15pt 制限のチューニングに使える。

---

## マッチング詳細パネル

`MatchingPage` の右ペインに案件サマリーを表示。

| 項目 | 内容 |
|---|---|
| 必須スキル | 上位 10 件まで（残りは "+ N 件" 表示） |
| 予算 | `budget_min`〜`budget_max` |
| 勤務地 | `work_location` |
| リモート | `remote_policy` |
| 開始日 | `start_date` |
| 案件概要 | `roleSummary` / `description` の先頭 150 字 |
| **元メール本文** | コミット `b1569ef`：折りたたみで元メール全文を表示できる |

スコア色分け（`scoreColor`）:
- 80 以上: 緑
- 60 以上: 黄
- それ未満: 灰

---

## bulk マッチングの進捗・キャンセル

`MatchingPage` は bulk 実行中に進捗を表示（`MatchRunProgress`）。

```
案件 N/M（タイトル） · 候補者 N/M 件目 · 全体 done/total
```

- キャンセル機構: `bulkCancelRequestedRef` を立てるとループが停止
- MatchingPage は常時マウント（`hidden` で切替）。タブ切替で mutation が中断されないように設計

---

## エラー収集

MatchingPage の全 mutation の `onError` で `logError(e, 'MatchingPage', undefined, { dataEnv, nickname })` を呼び、`error_logs` テーブルに保存される（コミット `a2c0e96`）。自動マッチ / バルクマッチの失敗を後追い可能。

---

## 現状の制約・既知の課題

| 課題 | 具体例 |
|---|---|
| スキル文字列の完全/includes 一致 | 案件「React」、候補者「react.js」→ SQL 側は完全一致のみ、`match-batch` 側は includes が効くので 0.5pt 加算される |
| 表記ゆれ吸収は skill_master.aliases 任せ | aliases に登録されていれば吸収可、未登録なら別スキル扱い |
| 駅マップの同名衝突 | 「町田」「野田」「福島」は **`station_master` DB の最後の登録勝ち**（要改善） |
| 業界・役割の重み | スコア配点に直接は含まれず、AI 再採点プロンプトで観点として渡される |
| AI スコア ±15pt 制限の副作用 | AI が「実はとても良い」と判断しても rule±15 内に制限されるため、ruleScore が低い候補は AI でも上位化しにくい |

---

## 関連設定

| 設定項目 | デフォルト | 変更場所 |
|---|---|---|
| マッチング実行モード | `fast` | 設定タブ > マッチング動作（`matching_run_mode`） |
| 高速モード 案件ごとの候補者上限 | 20 人 | 設定タブ > マッチング動作（`matching_fast_max_candidates`） |
| 高速モード 人材ごとの案件上限 | 10 件 | 設定タブ > マッチング動作（`matching_fast_max_projects`） |
| 自動マッチング有効 | `true` | 設定タブ > 自動マッチング ON/OFF（`auto_match_enabled`） |
| 即時マッチング（inbound-email 経由） | `false` | Supabase Secrets `AUTO_MATCH_ENABLED` |
| **スコアウェイト** | 40/15/15/20/10 | `match-batch` の `weights` パラメータ / `fetch_candidates_for_project` の RPC 引数 |

---

*最終更新: 2026-05-28（Phase 4.13/4.14 反映・SQL 側ルールスコア化・地方加点・ウェイト可変・京都バグ修正）*
