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

### Step 4: 当日夕方の総括

```bash
node scripts/monitor_quality.mjs --days 1
```

- 「添付ありskillYears空」が出たファイルは `testData/excel/` に追加して
  CLAUDE.mdの精度改善ループへ（これは恒常運用）

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
