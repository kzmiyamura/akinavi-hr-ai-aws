# 引き継ぎ: Excel実データ スキル年数・経験年数 検証ループ

## タスクの本質
Supabase Storageの本番`resume_url`（`data_env='prod'`、841件）を1件ずつダウンロードし、
中身を目視してスキル年数・経験年数の期待値を算出 → `inbound-email`で再処理 →
DB上の抽出結果と突き合わせ → 不一致があれば `supabase/functions/inbound-email/index.ts` を
修正 → 再テスト → デプロイ、というサイクルを**全件一致するまで繰り返す**。
ユーザー指示: 「止まらず走り続けろ、５時間セッション制限まで」「判断はこちらでしていい」。

## 進捗
- 検証済み: 約90件（バッチ1〜9、各バッチ8〜10件）
- 累計バグ修正数: 約25件
- 次回開始位置（カーソル、`created_at`降順で未処理分を取得）:
  ```sql
  SELECT id, name, resume_url, experience_years, jsonb_array_length(skills) as skill_count
  FROM candidates
  WHERE data_env = 'prod'
    AND resume_url LIKE '%/storage/v1/object/public/attachments/resumes/%'
    AND created_at < '2026-07-06 05:17:07.749218+00'
  ORDER BY created_at DESC
  LIMIT 10;
  ```
  （offsetページングは同秒重複で不安定なため、カーソル方式に切替済み）

## 未完了の直近作業（要再開）
1. バッチ9の6件（M.Y, T.M, 金HK, D.S, K.S, A.K）がdemo環境に残ったまま未削除:
   ```
   79c3d124-1f62-49d2-9eab-6c4c89776a24 (M.Y)
   e3296592-04f4-48d1-8372-c9139dc1a68e (T.M)
   ded2d9e3-9d95-4196-98f6-539ee0bdaeda (金HK)
   ed8a071e-fa89-4956-a5ce-a4dfa8598866 (D.S)
   714f3781-db3d-4f22-8415-e164804ae5ba (K.S)
   e38f93e7-470d-457c-9cf4-1eff477f2782 (A.K) ← experience_years=0バグ修正後、再テスト未実施
   ```
   A.K（`/tmp/real_excel_verify/batch9/AK2.xlsx`）を再送信し、`experience_years`が
   `0`ではなく`5`前後（27歳-22）になっているか確認 → 全6件をDELETEしてから次バッチへ。

## 直前に発見・修正した重大バグ（本番データに実害あり）
複数人材紹介メール（Excel添付1件＋本文のみの候補者複数名）で、「1対1残余マッチング」
ロジックが、添付内容に全く名前の手がかりがない場合でも機械的に割り当ててしまい、
**全く無関係な他人の経歴書が誤って共有される**バグを発見。
- 実例: 本番`李 RC`(id `48225721-a45d-4e76-a509-388a0fabe20c`)のresume_urlが実は
  `王KS`さんの経歴書だった。`S・U`(id `449e091c-ace4-4bfe-bb28-948826990b48`)の
  resume_urlが実は`N・A`さんの経歴書だった。
- 対応: 両レコードのresume_urlをNULLに修正済み（本番データ修正、実施済み）。
- コード修正: `index.ts`のケースB（1対1残余マッチング）に、添付内容に自分の名前が
  含まれるか確認する安全チェックを追加済み・デプロイ済み。
- 回帰確認: `scripts/verify_multi_candidate.mjs`の10シナリオで46/50 PASS
  （残り4件はシナリオ10のテストスクリプト自体の生成ロジック限界で、今回の変更以前から
  存在する既知の問題。新規回帰ではない）。

## このセッションで解決した主な判断事項
1. **経験年数の優先順位**: 「経験年数／実務経験／開発経験／IT歴系／社会人歴系」という
   専用ラベルからの明示的自己申告値（`experienceYearsIsDedicated: true`）は、Excel日付
   スパン推定より優先し上書きしない。T.Sさんのケース（本文が内訳の一部だけの場合は
   Excel優先のまま）は回帰なし確認済み。
2. **ヘッダー行/値行分離パターン**（例: `フリガナ|性別|年齢|実務経験`という見出し行の
   次の行に値が並ぶ形式。3件で発見: FT.xlsx, AT.xls, FT2.xlsx）への対応は、生グリッド
   構造への深い改修が必要でリスクが高いため**見送り**。既知の限界として記録。
3. **experience_years=0のサニティチェック**: Excelのセル分断構造（年の値と月の値が
   別セルに分離）から断片的な`0`が誤って経験年数として採用されるケースを検知し、
   年齢フォールバックに回すよう修正済み。

## その他の既知の限界（対応不要・記録のみ）
- T.A: 「一般事務期間をIT経験年数としてカウントすべきか」という業務ロジック上の疑問、
  ユーザー未回答のため保留。
- Y.M: スキル名の断片化（"Tera"/"Term"が"Tera Term"と分離）、スキル正規化の深い課題、
  対応見送り。
- TT.doc: 古い`.doc`バイナリ形式は`mammoth`非対応。ライブラリ追加が必要、対応見送り。
- KH2.xlsx: 極端に長いスペース区切りラベル＋疎な列構造で名前抽出失敗、安全に「不明」
  フォールバックするため致命的ではないと判断、深追いせず。
- IT.xlsx: イニシャルが"I"と"T"に分断され別セルに配置される特殊レイアウト崩れ、1件限りの
  特殊事例。
- MH.xls: 元Excel自体に氏名が未記入（意図的匿名化の可能性）。経験年数等は正しく取れている。

## 標準作業フロー（毎回このサイクル）
1. 上記カーソルクエリで次の未検証10件取得（既存チェック済みIDと重複あれば除外）
2. `curl`でファイルを`/tmp/real_excel_verify/batchN/`にダウンロード
3. `node -e "XLSX.readFile(...)"`で中身を目視、期待値を仮説立て
4. `curl -X POST .../functions/v1/inbound-email`で`mode:"demo"`送信して再処理
5. `mcp__supabase__execute_sql`で`name, experience_years, raw_profile->'age'`等を確認
6. 不一致があれば`index.ts`を修正 → 以下を必ず実行:
   ```
   deno check --no-npm supabase/functions/inbound-email/index.ts
   python3 -c "print(open(path,'rb').read().count(b'\x00'))"  # NUL混入チェック
   node scripts/sync_extractors.mjs
   node scripts/test_excel_parsing.mjs --compact
   node scripts/verify_email_extraction.mjs
   bash scripts/check-and-deploy-edge.sh inbound-email
   ```
7. 修正確認後、demo環境のテストレコードを`DELETE FROM candidates WHERE data_env='demo' AND id IN (...)`で削除
8. バッチの発見内容をユーザー向けに表形式で報告

## 認証情報
Edge Function呼び出し用anon key・プロジェクトURLは会話内で使用済み
（`https://argizomylbolpqxgmvim.supabase.co/functions/v1/inbound-email`）。
別PCでは`.env`または`supabase secrets`から再取得が必要な場合あり。

## Git状態
このバグ修正群はまだ**コミットされていない**（デプロイのみ実施、コミットは未指示）。
`git status`で`supabase/functions/inbound-email/index.ts`等の差分を確認し、
ユーザーの指示があればコミットすること。
