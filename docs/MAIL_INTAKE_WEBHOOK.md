# メール取り込みの第2経路（転送 + Webhook）

オンプレ版で「Microsoft Graph が使えない顧客」からメールを取り込むための経路。
**今動いている Graph ポーリング経路には一切手を入れていない。**

```
【既存・無改造】 Outlook ──Graph──> poll-email ──────────────┐
                                                             ├──> inbound-email ──> DB
【追加】 顧客メールボックス ─転送─> 受信サービス ─POST─> inbound-mail-webhook ─┘
```

## なぜ Graph を標準にしないか

| | Graph | 転送 + Webhook |
|---|---|---|
| 顧客の作業 | Azure アプリ登録 + **管理者同意** | 転送ルール1本 |
| 壊れ方 | **黙って止まる**（下記） | 配信失敗が受信サービスのログに残る |
| 顧客の要件 | Microsoft 365 必須 | どのメールでも可 |

Graph 経路で実際に起きた停止:

- **2026-08-17** … トークンが上書きされ、丸1日「未読0件」を返し続けた。エラーは出ない
- **2026-08-28** … Outlook 側の bot 判定で7時間停止

OAuth のトークン回転は、顧客先に置く製品としては一番壊れやすい部分。
IMAP/転送はアプリパスワードか転送ルールだけで動き、黙って死ににくい。

## ⚠ 転送メールは素通しすると中身が消える

実装を読んで分かったこと（2026-10-03）。`inbound-email` の
`STRONG_QUOTE_DELIMITERS` は区切り線を見つけると **`body.slice(0, m)`** を採る
＝区切り線より「前」を残す。これは**返信**の引用（新しい本文が上）には正しいが、
**転送**では欲しい中身が転送ヘッダの「下」にあるので逆になる。

```
（転送者の署名や「ご確認ください」）   ← これだけが残る
---------- 転送メッセージ ----------
差出人: 山田 <y@agency.co.jp>
件名: 【人材】Java 10年
（本当に欲しい人材情報）               ← 丸ごと捨てられる
```

前置きが空なら区切り線が位置0になり `m > 0` が false で切られずに通るが、
Outlook のように署名を上に付ける設定だと**静かに中身が消える**。

そこで `inbound-mail-webhook` 側で転送ヘッダを展開し、`inbound-email` には
「転送でない普通のメール」に見える形だけを渡す。

## ⚠ 差出人を間違えると静かに全部消える

`inbound-email` は `from` のドメインが `app_config.own_email_domain` と一致すると
**OWN_DOMAIN としてスキップ**する。顧客が自分のメールボックスから転送すると
`from` が顧客自身になりうるので、復元に失敗したまま渡すと**全件スキップ**される。

さらに `inbound-email` の `parseFrom` は Graph の JSON しか剥がさないので、
`山田 <y@agency.co.jp>` を渡すと `from.split('@')[1]` が `agency.co.jp>` になり
（末尾に `>` が残る）`agent_companies` の突き合わせが静かに外れる。

この2つを避けるため、アダプタは:

1. 転送ヘッダから**原メールの差出人**を復元する（Gmail / Outlook / 全角コロン対応）
2. 必ず**素のアドレス**に落とす（表示名・山括弧・大文字を除去）
3. 復元できなかった場合は **422 を返して止める**。黙って 200 を返さない

## 対応している受信サービス

| サービス | 判別キー | 本文 | 添付 |
|---|---|---|---|
| SendGrid Inbound Parse | `envelope` + `charsets` | `text` / `html` | multipart のファイルパート |
| Mailgun Routes | `body-plain` | **`body-plain`**（`stripped-text` は使わない） | 同上 |
| Postmark Inbound | `TextBody` / `FromFull` | `TextBody` / `HtmlBody` | `Attachments[]` |
| CloudMailin | `plain` + `headers` | `plain` / `html` | `attachments[]` |
| generic（Make / Pipedream / 自前） | — | `body`,`text`,`plainText`… を順に | `attachments[]` |

Mailgun の `stripped-text` を使わないのは、**Mailgun が引用を削った結果
転送ヘッダも消えて差出人を復元できなくなる**ため。生の `body-plain` を見る。

## 認証

`verify_jwt = false`（外部サービスは Supabase の JWT を持てない）。
代わりに共有シークレットで守る。

- ヘッダ `X-Webhook-Secret: <秘密>` … 推奨
- クエリ `?secret=<秘密>` … ヘッダを付けられないサービス向けの逃げ道

Secret 名は `INBOUND_WEBHOOK_SECRET`。**未設定なら全リクエストを 503 で拒否する**
（設定漏れで誰でも投稿できる状態になるのを防ぐ。開けっぱなしより閉じて落ちる方が安全）。

⚠ クエリで渡すと受信サービスのログや Supabase のアクセスログに秘密が残る。
ヘッダが使えるサービスなら必ずヘッダを使う。

`inbound-email` 側の `verify_jwt = true` は変えていない。この関数が
service role key を付けて内部的に呼ぶ。

## 返す HTTP ステータス

受信サービスは 2xx 以外だと再送してくれるので、それを前提に分ける。

| | 意味 |
|---|---|
| 200 | `inbound-email` に渡せた（解析の成否はあちらの責任） |
| 401 | シークレット不一致 |
| **422** | **このまま渡すと静かに捨てられる形だった**（差出人が復元できない等） |
| 502 | `inbound-email` が失敗。再送してほしいので 5xx |
| 503 | `INBOUND_WEBHOOK_SECRET` 未設定 |

「静かに 200」を返さないのがこの関数の一番大事な性質。

## 動作確認

デプロイ前にロジックだけ確認する:

```bash
npx vitest run src/lib/__tests__/mailWebhookNormalize.test.ts
```

デプロイ後、`inbound-email` に渡さずに正規化結果だけ見る:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/inbound-mail-webhook?dry_run=true" \
  -H "X-Webhook-Secret: $INBOUND_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"from":"田中 <tanaka@customer.co.jp>","subject":"転送: 【人材】",
       "text":"---------- 転送メッセージ ----------\nFrom: 山田 <y@agency.co.jp>\nSubject: 【人材】Java\n\n氏名: A.B\nスキル: Java"}'
```

`from` が `y@agency.co.jp`（転送者ではなく原メールの差出人）になっていれば正しい。
`data_env=demo` を付けると demo 環境に入るので、本番を汚さずに経路ごと試せる。

## 設定手順（顧客側）

1. 受信用アドレスを決める。**顧客のドメインでエイリアスを作ってもらうのが本筋**
   （`jinzai@顧客ドメイン`）。無料の outlook.com / gmail.com は顧客の情シスが
   嫌がることが多く、監査でも引っかかる
2. そのアドレス宛のメールを受信サービスの Webhook に流す設定を入れる
3. `INBOUND_WEBHOOK_SECRET` を発行して受信サービス側のヘッダに設定
4. `?dry_run=true` で1通試し、`from` が代理店になることを確認してから外す

## 未了

- **IMAP ポーリング経路**（独自ドメイン・さくら等、受信サービスを挟めない顧客向け）。
  この関数と同じ正規化を使い、ローカル常駐ワーカー側から叩く形を想定
- 受信サービスの署名検証（今は共有シークレットのみ）。
  SendGrid/Mailgun は署名を出せるので、顧客要件次第で足す
