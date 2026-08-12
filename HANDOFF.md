# 引き継ぎ（2026-08-12 時点）

## 1. まず再起動後に確認すること

pm2 は `pm2 save` 済みなので、ログオン時に自動復元される想定
（スタートアップの `motion-lab-pm2-resurrect.cmd` に相乗り）。

```powershell
pm2 list
```

`akinavi-shadow` が `online` なら正常。`stopped` や一覧に無い場合:

```powershell
pm2 resurrect
```

ログの確認:

```powershell
Get-Content ~/akinavi_shadow.log -Tail 20
```

正常なら次のような行が出る。

```
ワーカー起動 mode=本番上書き 方式=キュー(新しい順・直近3日) 上限=15/cycle, 100/day
未処理 N件を処理（新しい順・直近3日・スキル絞込[Java,C#]・今サイクル枠N件）
```

## 2. 明日いちばんに見るもの: Supabase の egress

**これが今いちばん重要な判定。** ダッシュボード → Usage → Egress のグラフに
カーソルを当てると種別ごとの内訳が出る。**PostgREST の値**を見る。

| PostgREST | 意味 | 次の手 |
|---|---|---|
| 50MB/日 以下 | 対策成功 | 追加対応不要 |
| 100MB/日 前後 | 部分的に効いた | 残る `invalidateQueries` を潰す（下記5参照） |
| 200MB/日 以上 | **主因の見立てが誤り** | 一から再調査。推測で直さないこと |

参考: 2026-08-10 は PostgREST 291MB（全体の91.6%）だった。
無料枠は 5GB/月 ＝ 約166MB/日。

## 3. ワーカーの現在の設定

| 項目 | 値 | 変え方 |
|---|---|---|
| モデル | **Haiku 単独**（Sonnet 廃止） | `SHADOW_USE_SONNET=1` で復活 |
| 日次上限 | **100件/日** | `SHADOW_MAX_PER_DAY` |
| 対象期間 | **直近3日**（それより古いものは処理しない） | `SHADOW_LOOKBACK_DAYS` |
| 取得順 | 新しい順（キュー方式・watermark 廃止） | — |
| ペース配分 | 上限を24時間に均す（約4件/時） | — |
| スキル絞込 | **Java, C#** | 設定画面 or `set_filter_skills.mjs` |

実績: 2026-08-11 は 100件・**$8.74**（1件$0.087）。
前日は227件・$37（1件$0.163）だったので、1件あたり約47%減。

env を変えて再起動する場合は `--update-env` が必要。

```powershell
pm2 restart akinavi-shadow --update-env
```

## 4. 今日入れた主な変更（すべて push・デプロイ済み）

**バグ修正**
- ワーカーが `p.stdin` の未処理 error でクラッシュしていた（再起動19回の一因）
- 処理枠を超えて15件取得し、本文抽出の費用を捨てて毎回払い直していた
- 添付が無い人材まで本文LLMを省略し、申告年数・商流・スキル年数を取り逃していた
- 一覧の全件再取得（1人の変更で最大650KB）
- 調査スクリプトが `raw_profile` を300件分（約10MB）取っていた

**抽出精度**
- 縦積みヘッダーで言語列が見つからずスキル年数0件（回帰 2Pass → 9Pass）
- スキル一覧表のヘッダーを案件表の技術列と誤認（A_S）
- PDF のテキストが改行ゼロの1行になり構造解析が全滅
- 勤務形態に「経歴書の案件説明」「メール件名」「括弧見出し」が混入
- 派遣許可番号の旧表記（般/特）・全角を取りこぼし
- 氏名に生年月日・スキル分類が入っていた（全角数字が `\d` をすり抜けていた）

**方針変更**
- 判定を「Sonnetに昇格するか」から「人が見るべきか」に再設計。
  needs_review は壊れているものだけ（65% → 3.4%）、品質は数値で `llm_shadow.quality` に保持
- 総経験年数を `max(案件表の計算値, 自己PRの申告値)` に（T.A で6年→24年に是正）

## 5. 未解決・次にやるなら

**egress（明日の数字次第）**
- `invalidateQueries(['candidates-paged'])` がまだ5箇所ある。
  ただし新規登録・再解析は一覧の構成が変わるので `invalidate` が正しい。
  手元に新しい値がある単一人材の変更だけ `src/lib/candidateCache.ts` で置き換える

**抽出精度**
- `Y_O.xlsx` のスキル年数ゼロ（シートに `#REF!` が多数）
- `A_S.xlsx` の内部矛盾（スキル44ヶ月 > 総経験13ヶ月）
- 総経験年数のフェーズ合算（「2年半＋3年半＋6年」型は未対応。明示値のみ拾える）
- PDF の行復元が61件の失敗をどれだけ救うかは未検証。
  `node scripts/audit_skillyears_gap.mjs 3` の「経歴書あり・抽出できず」の推移で判定する

**構造的に解決できないもの（記録のみ）**
- 添付が無い人材が18.4%。経歴書が送られてこないので、どんな抽出器でも取れない
- カタログ型（スキル一覧のみで期間が無い）経歴書も同様

## 6. よく使う確認コマンド

```powershell
node scripts/audit_recent_quality.mjs 10      # 直近10件の読み取り品質を目視
node scripts/audit_skillyears_gap.mjs 3       # スキル年数が取れない原因の内訳
node scripts/audit_bad_names.mjs              # 氏名が壊れているレコード
node scripts/llm_extract/cost_per_call.mjs 2026-08-11T00:00:00Z 2   # 1回あたりコスト
npx supabase db query --linked -f scripts/sql/table_sizes.sql       # DB容量
node scripts/test_excel_parsing.mjs --compact # Excel回帰（10件）
```

**注意**: `testData/excel/` は PII のため git 管理外。空だと回帰が Total 0 で
空回りする（合格に見える）。空なら `node scripts/download_failing_excels.mjs` で再取得。

## 7. egress を無駄遣いしないための鉄則

調査で自分が使ってしまうので注意。

- **`raw_profile` を丸ごと select しない**（1件約35KB、`attachmentText` が13KB）。
  JSON パスで必要な項目だけ取る: `select=id,sy:raw_profile->skillYears`
- 件数は `select=count` で数える。レコードを取って数えない
- `sb-query.mjs` は既定で最大1000件返す。`limit` を必ず付ける
