# 7/23 Supabase復旧日ランブック

**目的**: egressクォータ超過（402制限・7/10頃発生）が7/23の課金サイクル更新でリセットされた際に、
停止期間中にデプロイした新パイプライン（設計書v4）を安全に本番投入し、初日で品質を確認する。

## 前提（7/12時点の状態）

- **本番は402制限中**: REST/DB/ポーリングすべて停止。Edge Functionデプロイのみ可能だった
- **デプロイ済みコード**: `42e8126`（統一入力パイプライン+リンク型名簿+全バグ修正）
  - 検証状態: 分岐網羅 120/120・E2E 21/21（実ファイル+実Googleリンク）・既存回帰0劣化
- **超過の原因**: 品質チェックスクリプトが本番RESTから大量取得していたこと（1回500MB〜1GB）
- **停止中のメール**: 未読のまま受信箱に蓄積（約2週間分）。復旧後の初回ポーリングから
  `email_poll_mode=incremental`（未読のみ）で順次流入する

## 復旧当日の手順

### Step 1: 復旧確認（朝イチ）

```bash
# RESTが200を返すか（402のままなら未リセット。課金サイクルはダッシュボードで確認）
node scripts/check_extraction.mjs --days 1
```

- ダッシュボード → Usage → Egress が0付近にリセットされていることを確認
- **注意**: リセット後もこの日は品質チェックスクリプトの連打をしない（超過の再発原因）

### Step 2: 流入バーストの監視（ポーリング再開後 1〜2時間）

未読2週間分が5分間隔のポーリングで順次処理される。二重処理はdedupが防ぐ。
何もしなくてよいが、以下だけ確認する：

```bash
# 不変条件違反（サイレント失敗）が出ていないか
node scripts/trace_email.mjs --violations --days 1

# 品質監視の6チェック一括
node scripts/monitor_quality.mjs --days 1
```

**見るポイント**:
- 🚨 invariant違反 > 0 → `node scripts/trace_email.mjs <id>` でトレース確認・最優先対応
- 名前がラベル語（「保有技術」等）のゴミ候補者がいないか（名簿誤検出の再発チェック）
- 同一人物の分裂登録がないか

### Step 3: 新機能の実流入確認（当日中）

停止期間中に届いたメールには Sheets/Docs リンク付き・名簿付きが含まれるはず。
新パイプラインの本番初動作を確認する：

```bash
# Sheetsリンク付きメールの候補者を1件開いてトレース確認
node scripts/trace_email.mjs --name "<候補者名>"
```

- `A-XLSX-OK` → `B-EXTRACT-OK` → `E-URL-STORAGE` が並んでいれば正常
- gid付きリンクなら `B-SHEET-GID` の出現を確認
- 名簿メールが来ていたら `C-ROSTER` → `C-ROW-LINK-OK` → 複数登録を確認

### Step 4: 案件メール誤登録の監査（当日〜数日以内に1回）

Task #2（prod candidates +3,002 vs projects +3 の乖離）の実データ調査。
ai_logs は30日保持なので、復旧後早めに実行して過去分を確保する:

```bash
node scripts/audit_misregistration.mjs --days 30 --dump audit_result.json
```

- **[A] 現行パターンで捕捉可能** → 当時パターンが無かっただけ。件数の把握のみでOK
- **[B] スキップ対象の混入** → 同上
- **[C] ヒューリスティック疑い** → ★本命。シグナル頻度表を見て `poll-email` の
  `PROJECT_BODY_PATTERNS` にパターンを追加 → 再実行して[C]が[A]に移ることを確認
- 誤登録と確定した candidates の削除は**ユーザー確認の上で**実施（本番データ変更のため）

### Step 5: 当日夕方の総括

```bash
node scripts/monitor_quality.mjs --days 1
```

- 「添付ありskillYears空」が出たファイルは `testData/excel/` に追加して
  CLAUDE.mdの精度改善ループへ（これは恒常運用）

### Step 6: PDF経歴書の本番動作確認（当日でなくてよい・週内に1回）

**7/18更新: PDFテキスト抽出は実装済みだったことが判明**（unpdf・メール添付は `index.ts:7152`、
Drive/リンク経由は extractEntry の kind=pdf 分岐）。v5設計書の「PDF解析なし」は古い記述だった（修正済み）。
さらに7/18に以下を修正してデプロイ済み:

- **康熙部首・CJK部首補助の正規化バグ修正**: PDF生成ソフトが「氏→⽒」「西→⻄」等の
  部首コードポイントを出力し、【氏名】・駅名regexが全滅する実害を実PDFテストで発見。
  `normalizePdfRadicals` で通常漢字に正規化（NFKC + 明示マップ18字）
- unpdf のバージョンを @1.6.2 に固定（従来は未固定でコールドスタート時の破損リスク）

復旧後にやること:

```bash
# PDF添付メールが処理されたら trace で確認（B-EXTRACT-OK pdf t=NNN が出ること）
node scripts/trace_email.mjs --name "<PDF経歴書の候補者名>"
```

1. **流量集計**: candidates.resume_url が .pdf の割合を直近30日で集計（大量取得はローカル環境で）
2. **実PDFで氏名・駅名・スキルが取れているか確認**。取れていないPDFがあれば実ファイルを
   `testData/` に追加して改善ループへ（部首正規化の漏れ字種が見つかったらマップに追加）
3. 表構造（スキル×年数ペア）はテキスト化で崩れるため Excel より精度が落ちる。
   ここは AIフォールバック設計（ai-enrich-design-v1.2.html）の領域

## 恒常運用ルール（再発防止）

| ルール | 理由 |
|---|---|
| **品質チェックの大量取得スクリプトは本番RESTに向けない** | egress超過の直接原因。ローカルSupabase環境（`scripts/setup_local_test_db.sh`）で実行する |
| **週次で `monitor_quality.mjs --days 7` を1回だけ実行** | JSON部分選択で1回数百KB程度に抑えてある |
| **新フォーマットWARNは testData に追加して改善ループ** | スキル年数抽出はフォーマット理解の問題であり、検知→改善の運用で潰す |

## 緊急時ロールバック

```bash
git revert <問題のコミット> && git push
bash scripts/check-and-deploy-edge.sh inbound-email
```

新パイプライン全体を戻す場合は `fcf218b` の1つ前（`e8c63eb`）まで revert が必要だが、
名簿誤検出などの重大修正も一緒に消えるため、**原則は前方修正**（トレースで原因特定→ピンポイント修正）。

## 参考

- テスト項目書: `test_specification.html`（分岐網羅120+E2E21+実Google結合の全結果）
- 改善履歴: `scripts/testData/improvement_log.md`
- トレースの読み方: エントリごとの最終コードが「こけた場所」。`invariantViolations` が空でなければサイレント失敗
