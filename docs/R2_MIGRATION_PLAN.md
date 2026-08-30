# 添付ファイルの Cloudflare R2 移行計画

作成: 2026-08-30

## なぜやるか

2026-08-30、Supabase のストレージ枠（Free 1GB）超過でプロジェクト全体が停止した。
API が 402 を返し、営業が使うアプリが使えなくなった。

原因は `raw/`（受信添付の控え）が掃除の不具合で 1.7GB まで膨らんだこと。実サイズは
その後 204MB まで削ったが、**Supabase が見るのは請求期間の平均**（Average in period）で、
超過した数日が平均を押し上げたまま解除されず、**Pro へのアップグレードでしか復旧できなかった**。

つまり「超えたら減らす」では間に合わない。**添付を Supabase から出す**のが構造的な対策になる。

## 移行先: Cloudflare R2

| | Supabase Free | Supabase Pro | Cloudflare R2 |
|---|---|---|---|
| 容量 | 1 GB | 100 GB | **10 GB（無料枠）** |
| 取り出しの通信料 | egress を消費 | egress を消費 | **無料・無制限** |
| 料金 | $0 | **$25/月** | **$0**（無料枠内） |
| カード登録 | 不要 | 必要 | **必要**（課金はされない） |

Backblaze B2（10GB）も候補だが、R2 は取り出しが無料で、既に Cloudflare の
アカウントがある（別プロジェクト motion-lab で Pages と cloudflared を使用中）。

## 進め方

### 前提: 9/23 まで Pro を維持する

いま Free に戻すと、**請求期間の平均が 0.989GB のまま残っている**ので即座にまた
制限がかかる。平均がリセットされるのは次の請求期間（9/23）から。

```
8/30        Pro にアップグレード（完了）
8/30〜9月中 R2 へ移行
9/23        次の請求期間の開始と同時に Free へ戻す
```

### ステップ1: R2 の準備（人がやる）

Cloudflare ダッシュボードで:

1. R2 を有効化（初回はクレジットカード登録が必要。無料枠内なら課金されない）
2. バケット作成（例: `akinavi-resumes`）
3. 公開アクセスを有効化（Settings → Public access → `r2.dev` サブドメイン）
   - 経歴書リンクを画面から開くために必要
4. API トークン発行（R2 → Manage API Tokens → Object Read & Write・対象は該当バケットのみ）

発行される値を **Supabase の Edge Function Secrets に直接登録する**
（チャットやコマンドラインに貼らない。履歴に平文で残るため）:

```
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET        例: akinavi-resumes
R2_PUBLIC_BASE   例: https://pub-xxxx.r2.dev
```

**アカウントを分けるか**は要判断。motion-lab と同じアカウントに相乗りすると、
片方の設定ミスがもう片方に影響しうる。業務データを扱うこちらは分けるほうが安全。

### ステップ2: アップロード先の切り替え（コード）

対象は `supabase/functions/inbound-email/index.ts` の `uploadToStorage()` 1か所。
保存先を R2 に変え、公開URLを返す。R2 は S3 互換なので SigV4 で PUT する。

**設定が入るまでは従来どおり Supabase に保存する**（環境変数が無ければ現状維持）。
途中で止まっても取り込みが壊れない。

影響を受ける読み出し側:
- `src/lib/viewerUrl.ts` — Office 形式を Microsoft のビューアで開く分岐。
  R2 の公開URLでも同じ扱いでよい（`supabase.co/storage` の判定に R2 を足す）
- `supabase/functions/cleanup-storage/index.ts` — 保持日数での削除。
  R2 側は**ライフサイクルルール**（R2 の設定画面で日数を指定）に任せるほうが簡単

### ステップ3: 検証

1. demo（`data_env='demo'`）で1件登録し、R2 に保存され画面から開けることを確認
2. prod へ切り替え、翌日に `raw/` と `resumes/` が増えていないことを確認
3. Supabase 側のストレージが減り続ける（保持日数で自然に消える）ことを確認

### ステップ4: 9/23 に Free へ戻す

Supabase 側のストレージがほぼゼロになっていることを確認してから戻す。
`app_config.storage_quota_bytes` を `1073741824`（1GB）に戻す
（容量監視のしきい値。Pro の間は 100GB を入れてある）。

## 移行しないもの

- **DB**（0.263 / 0.5GB）… Free でも収まっている
- **Edge Functions** … Supabase のまま
- **`raw/`（受信添付の控え）** … 1日で消える。R2 に移す価値は薄い。
  ただし名簿メールの参照リンクが `raw/` を指しているので、
  移行する場合はそちらも合わせて切り替えること

## リスク

| リスク | 対応 |
|---|---|
| 個人情報を新しい事業者に預ける | 経歴書は他社から預かった個人情報。保持期間を業務で決めて守る |
| R2 の公開URLが推測されると誰でも読める | 現状の Supabase 公開バケットと同じ性質。気になるなら署名付きURLに変更可能 |
| 移行中に取り込みが壊れる | 環境変数が無ければ従来動作。demo で先に確認してから prod |
| 無料枠 10GB を超える | 容量監視をR2側にも向ける（`storage_usage()` と同じ考え方） |
