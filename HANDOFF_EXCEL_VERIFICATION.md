# 引き継ぎ: Excel実データ スキル年数・経験年数 検証ループ

## 次回最優先（要ユーザー判断）
バッチ14で **IS・IT・KKの3名**に「自己PRの自然文に書かれた総経験年数」と
「DB登録値」の大きな乖離を発見（詳細は下記セクション参照）。個別のregex修正では
なく、「自然文のキャリア記述を構造化データ（Excel経歴表の期間合計・日付スパン）と
合算する」という設計変更が必要になる可能性が高い。着手前に以下をユーザーに確認:
- この3名は氷山の一角で、同種の「自己PRに前職経験が書かれているが経歴表に
  現れないため合算されない」パターンが他の候補者にも広く存在する可能性がある
- 個別対応（3名分のピンポイント修正）か、設計変更（自然文キャリア合算ロジックの
  新規実装）かの方針をまず相談すること

「引き継ぎに入って」「バッチ検証を続けて」等の指示があれば、上記の方針確認、または
下記「次回開始位置」のカーソルから通常のバッチ検証ループを再開すること。

## タスクの本質
Supabase Storageの本番`resume_url`（`data_env='prod'`）を1件ずつダウンロードし、
中身を目視してスキル年数・経験年数の期待値を算出 → `inbound-email`で再処理 →
DB上の抽出結果と突き合わせ → 不一致があれば `supabase/functions/inbound-email/index.ts` を
修正 → 再テスト → デプロイ、というサイクルを**全件一致するまで繰り返す**。
ユーザー指示: 「止まらず走り続けろ」「判断はこちらでしていい」。

## 進捗
- 検証済み: 約130件超（バッチ1〜14、各バッチ8〜10件）
- 累計バグ修正数: 約37件超（バッチ14で2件追加）
- 次回開始位置（カーソル、`created_at`降順で未処理分を取得。バッチ14の最後の
  候補者T.Nの created_at を基準にする）:
  ```sql
  SELECT id, name, resume_url, experience_years, jsonb_array_length(skills) as skill_count
  FROM candidates
  WHERE data_env = 'prod'
    AND resume_url LIKE '%/storage/v1/object/public/attachments/resumes/%'
    AND created_at < '2026-07-06 01:46:36.770764+00'
  ORDER BY created_at DESC
  LIMIT 10;
  ```

## バッチ14の残り未確認事項（次回優先で深掘り）
以下3名で「自己PR等の自然文に書かれた総経験年数」と「DB登録値」に大きな乖離を発見。
いずれも構造化テーブル（Excel業務経歴の期間列）だけでは自己PR文中の追加キャリア
（前職・別フェーズの経験年数）を合算できておらず、共通の根本原因の可能性がある。
1件ずつのregex修正ではなく「自然文の経験年数記述を構造化データと合算する」設計が
必要になりそうなため、着手前にユーザーと方針確認が望ましい。
- **IS**（id: `0293498b-3ebe-4b63-a929-7b0cff8f0df6`）: 自己PRに
  「２年半」「約３年半」「６年」の3フェーズ計約12年の経験が明記されているが、
  DB `experience_years=6`（最後のフェーズのみ拾っている）。会社履歴表は
  2012年4月〜現在（2026年4月）で継続的に埋まっており、日付スパン推定でも
  14年程度が算出できるはず。
- **IT**（id: `f5ed94b8-c808-43e2-ba96-6d6ac54a021c`）: 自己PRに
  「業界6年目となりますが」との記載（≒5〜6年経験）。プロジェクト経歴表（Excel）
  の期間合計もおよそ5.5年相当。しかし DB `experience_years=2`。
  「N年目となります」という言い回しは現行の経験年数regexパターン
  （`expPatterns`、index.ts 2038行目付近）のどれにも一致しない上、
  Excel日付スパン推定側でも小さい値（2）が出ている原因が未特定。要調査。
- **KK**（id: `4dc29e3c-b874-4862-b6c3-a15387868ee5`）: 自己PRに
  「約10年間、金融系データセンターでオペレータとして従事」の記載後、
  SE/PGへのキャリアチェンジについても言及。Excel経歴表だけでも7年程度、
  データセンター期間10年を加えると17年程度になるはずだが、DB
  `experience_years=11`。データセンター期間（Excel表に一切現れない自己PR
  のみの記載）が合算されていない可能性。

## バッチ14で確認・問題なしと判断した候補者
- S.K: 経験年数ラベル「5年4ヶ月」明記 → DB `5` で一致
- H.K（`600bcaee-...`）: Excel経歴表の期間合計＋備考欄の前職期間（2010-2012、
  約2.75年）を足し合わせるとDB `7` とおおむね整合。問題なしと判断
- S.M: Excel経歴表がテーブル崩れ（同一プロジェクトが5回重複するなど、
  結合セル解析由来と思われる崩れ）で正確な期待値算出が困難。深追いせず
- 不明・T.N・H.K（`fa9db3c7-...`）・KKの詳細裏取りは未実施（時間の都合で
  次回に持ち越し）

## 既知の課題（未対応・要フォロー）
- `scripts/testData/excel/` ディレクトリがローカルから消失している
  （.gitignore対象＝候補者PIIのため元々git管理外。過去セッションでダウンロード
  した実データがディスク上からも無くなっている）。`node scripts/test_excel_parsing.mjs`
  がこのディレクトリ前提でクラッシュするため、skillYears系の14件リグレッションが
  今は実行不可。次回セッションで気づいたら、過去バッチで検証した候補者の
  resume_urlから再ダウンロードして復元するか、対応方針をユーザーに確認すること。

## バッチ14（2026-07-08）で発見・修正した2件のバグ

### 1. MK_S候補者の年齢抽出バグ → 修正済み
- 修正内容: `extractCandidateFieldsRegex`（ラベルなしフォールバック）に
  `bareAgeGenderPat` を追加。「氏名　N歳性別」（括弧・区切り記号なし、全角スペース
  のみ）形式に対応。`supabase/functions/inbound-email/index.ts` と
  `scripts/test_extraction.mjs` の両方に同一パターンを追加済み（後者は
  index.tsとの手動同期が必要な旧式コピーのため要注意）。
- 検証結果: `node scripts/test_extraction.mjs --test` 154 passed, 0 failed。
  MK_S再解析後 `age=48` `gender=男` `experience_years=38→26` に是正確認済み。
- デプロイ・コミット・push 済み（commit 72c65d4）。

### 2. 複数人材メールの「未割当添付の安全共有」チェックが短いイニシャル名で素通りする不具合 → 修正済み
- 対象: S・F候補者（id: `08f52733-1437-485a-a8a2-e3d210fb870b`）。1通のメールに
  6名（C・Y, K・T, M・M森, M・T松田, H・M原田, S・F）が記載され、添付Excelは
  C・Y本人の経歴書1件のみ。ブロック分割は成功していたが、C・Yの添付が
  「ケースB（残り1件を安全に共有）」の安全チェックをすり抜けてS・Fに誤って
  紐付いていた。
- 原因: 安全チェックが添付内容の全空白（`\s`・全角スペース）を除去してから
  候補者名の正規化文字列（2文字程度のイニシャル）を`includes()`で検索していたため、
  Excel内の無関係な隣接セル「JBOSS」+「FrameWork」が連結されて偶然
  「…ossf…」となり、「S・F」→`sf`が偶然一致 → 安全チェックが機能しなかった。
- 修正: `supabase/functions/inbound-email/index.ts` の該当2箇所
  （ケースB安全チェック・`assignAttachmentsToBlocks`パス2.5）で、添付内容側の
  文字列正規化から空白除去をやめ、名前内部の区切り文字（`.`・`・`）のみ除去する
  ように変更。セル・行の境界を跨いだ偶然の文字列連結を防止。
- 検証: `node scripts/test_extraction.mjs --test` 154 passed 0 failed。
  デプロイ後 `reanalyze_candidate.mjs` でS・Fを再解析し、`resume_url`が
  誤ったC・Yの経歴書から `null`（安全側フォールバック）に是正されたことを確認。
- なお、この修正とは別に「C・Y」名義の重複候補者レコードが2件存在する
  （`C・Y` と `C・Y【小林】`）ことが判明。異なるメールで氏名の姓カッコ書き
  有無が揺れて別レコード化した可能性があり、重複管理の観点で要フォローだが
  今回は未対応（スコープ外・別途調査推奨）。

## このセッションで修正した主なバグ（Issue #117〜#121 + Excel検証ループ発見分）
すべてコミット・push・デプロイ済み。

1. **Issue #117**: タブ移動で人材の絞り込みが消える → `CandidatePage` を常時マウント化
2. **Issue #118**: 人材マップ表示が遅い（2.5秒→6.4ms） → `prefecture_norm` 生成列 + trigramインデックス追加
3. **Issue #119 / #121 系**: skillYears抽出の異常値・誤マッチ多数
   - `parseDurationToMonths` が「カ月」（カタカナ）を認識しない
   - Method2（スキル一覧型）の年数⇔スキル名対応が前後±3列の固定窓のみで、
     列間隔の広いシートで無関係な隣接セルに誤対応付け
   - `filterSkillYears` に単一スキル480ヶ月(40年)超の異常値サニティチェックがなかった
   - `filterSkillYears` に「要件」「定義」「製造」等の工程見出しラベルのブロックリストがなかった
   - `extractSkillYearsFromBodyText` が他人の添付テキスト（ケースB/C共有プール）からも
     誤って年数を拾っていた → 確実にマッチした添付(matchedTextContent)のみに限定
4. **Issue #120**: PMOが「手法」（methodologies）に分類されていた → 「役割」相当として
   `others`カテゴリへ移動・`PROSE_ROLES`にPMOを追加
5. **Issue #121（本命）**: 複数人材メール分割で「名　前」（全角スペース入りラベル）に
   `NAME_FIELD_RE` が対応しておらず分割自体が失敗 → 単一候補者として処理され、
   メール内の唯一の添付が無関係な1名に誤って紐付いていた（T.Iに他人K.Sの経歴書）
   - 併せて、複数人材UPDATE時に `experience_years` / `resume_url` が条件付きでしか
     payloadに含まれておらず、古い誤った値が残り続けるバグも修正
6. **経験年数関連の追加修正**:
   - 「・項目：期間」箇条書き内訳のみで経験年数の明示ラベルがないケースの合算フォールバック追加
   - サニティチェックが `=== 0` の厳密等価判定だったため、Excel日付スパン推定の
     端数値（例: 0.3年）がMath.round後に0年になるケースをすり抜けていた → `< 1` の閾値判定に変更
   - 「経験年数は約2年と若手ですが」のような助詞を挟む自然文パターンに未対応だった
   - `extractFieldTwoPhase` のPhase2b（ラベルのみ行の直後行を値として採用）が、
     Excel結合セル崩れで値を失った氏名ラベル行の直後が別フィールドのラベル行
     （「年齢：31」等）だと誤ってその値を採用していた（**氏名が「年齢：31」になるバグ**）

## 既知の限界（対応不要・記録のみ、前セッションから引き継ぎ）
- T.A: 「一般事務期間をIT経験年数としてカウントすべきか」という業務ロジック上の疑問、保留
- Y.M: スキル名の断片化（"Tera"/"Term"が分離）、対応見送り
- TT.doc: 古い`.doc`バイナリ形式は`mammoth`非対応、対応見送り
- KH2.xlsx: 名前抽出失敗で「不明」フォールバック、致命的でないため深追いせず
- IT.xlsx: イニシャルが分断される特殊レイアウト崩れ、1件限りの特殊事例
- MH.xls: 元Excel自体に氏名が未記入（意図的匿名化の可能性）

## 標準作業フロー（毎回このサイクル）
1. 上記カーソルクエリで次の未検証10件取得
2. Node.jsで各Excelをダウンロードし、`XLSX.readFile`相当で中身を目視。
   経験年数・年齢が明記されている箇所を探し、DBの値と突き合わせる
   （`scripts`直下に一時ファイル `_tmp_batchN.mjs` を作って一括チェックすると効率的。
   終わったら `rm scripts/_tmp_batchN.mjs` で削除すること）
3. 不一致があれば `supabase/functions/inbound-email/index.ts` を修正
4. 以下を必ず実行:
   ```
   npx esbuild supabase/functions/inbound-email/index.ts --outfile=/tmp/out.js --target=es2022
   node scripts/test_extraction.mjs --test   # 既存回帰が0件劣化であること確認
   node scripts/sync_extractors.mjs
   git pull origin main
   npx supabase functions deploy inbound-email
   git add -A && git commit -m "fix: ..." && git push
   ```
5. `node scripts/reanalyze_candidate.mjs <ID>` で該当レコードを再解析し、DB上の値が
   正しくなったか確認（多くの場合 `type: "candidate"` の単一パスで再送信されるので、
   複数人材メールの場合は元のExcel添付を正しいファイル名で本番に再送信し直す必要がある
   ケースもある。詳細は当セッションのT.I/N.I関連の対応例を参照）
6. バッチの発見内容をユーザー向けに表形式で報告

## Git状態
このセッションのすべてのバグ修正は commit & push 済み（デプロイも都度実施済み）。
`git status` はクリーンなはず。

## 認証情報
Edge Function呼び出し用anon key・プロジェクトURLは `.env.local` から自動読み込み
（`scripts/*.mjs` は共通して対応済み）。
`https://argizomylbolpqxgmvim.supabase.co/functions/v1/inbound-email`
