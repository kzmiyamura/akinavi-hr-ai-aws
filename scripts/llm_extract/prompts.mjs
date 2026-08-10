// llm_extract/prompts.mjs — ベンチ(2026-08-02)で検証済みの転記プロンプト
// 方針: モデルは「転記」のみ。計算・正規化は一切させない（計算はJS側）

export const TRANSCRIBE_RULES = `あなたはIT技術者の経歴書(Excelシート)の読み取り係です。以下のJSONはExcelシートのグリッドです（rows=[行番号,[セル値...]]、結合セルは左上セルに値が入り、mergesが結合範囲）。

タスク: 経歴書に記載された「案件（プロジェクト）」を1件ずつ読み取り、忠実に転記してください。

ルール:
- 各案件について: 開始年月(start)・終了年月(end)・その案件で使用した技術(techs)を書き写す
- start/end は "YYYY/MM" 形式。継続中(現在/在籍中/〜今 等)は "present" とする
- techs はその案件の言語/OS/DB/FW/ミドルウェア/クラウド/ツール列(または【言語】等のセクション)に書かれた個々の技術名。セル内の改行・「、」「/」「,」区切りを分割して1つずつ列挙
- ツール行・環境行に書かれた技術も techs に含める
- 技術名は表記そのまま転記（勝手に正規化・翻訳しない。例: "PostgreSQL"と書いてあれば"PostgreSQL"）
- 【言語】【OS】等の見出し語・工程名(要件定義/基本設計/テスト等)・役割(SE/PL等)・業種名(金融/医療等)・人数/規模・ハードウェア機種名は techs に含めない
- 期間とtechsの対応が結合セルで表現されている場合はmergesを参照して正しく対応付ける
- 案件として日付範囲が読み取れない行は無視する
- 計算はしない。書かれている値の転記のみ
- 読み取りに自信が持てない場合は confidence を "low" にする

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"projects":[{"start":"YYYY/MM","end":"YYYY/MM または present","techs":["..."]}],"confidence":"high または low"}

--- 以下グリッドJSON ---
`

// docx/pdf 用。グリッド構造が無いため「期間の近くに書かれた技術を対応付ける」指示に置き換え
export const TRANSCRIBE_RULES_TEXT = `あなたはIT技術者の経歴書(WordまたはPDF)の読み取り係です。以下は経歴書から抽出したテキストです。表組みだった場合、1行が複数の欄の連結、またはセルごとの改行になっていることがあります。

タスク: 経歴書に記載された「案件（プロジェクト）」を1件ずつ読み取り、忠実に転記してください。

ルール:
- 各案件について: 開始年月(start)・終了年月(end)・その案件で使用した技術(techs)を書き写す
- start/end は "YYYY/MM" 形式。継続中(現在/在籍中/〜今 等)は "present" とする
- techs はその案件の言語/OS/DB/FW/ミドルウェア/クラウド/ツール欄(または【言語】等のセクション)に書かれた個々の技術名。改行・「、」「/」「,」区切りを分割して1つずつ列挙
- ツール欄・環境欄に書かれた技術も techs に含める
- 技術名は表記そのまま転記（勝手に正規化・翻訳しない。例: "PostgreSQL"と書いてあれば"PostgreSQL"）
- 【言語】【OS】等の見出し語・工程名(要件定義/基本設計/テスト等)・役割(SE/PL等)・業種名(金融/医療等)・人数/規模・ハードウェア機種名は techs に含めない
- 技術は「その期間の記載に最も近い位置」に書かれた案件へ対応付ける
- 案件として日付範囲が読み取れない記述は無視する
- 計算はしない。書かれている値の転記のみ
- 読み取りに自信が持てない場合は confidence を "low" にする

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"projects":[{"start":"YYYY/MM","end":"YYYY/MM または present","techs":["..."]}],"confidence":"high または low"}

--- 以下経歴書テキスト ---
`

// 本文抽出は1件あたりの実処理が20秒程度なのに対し、claude -p は起動ごとに
// システムプロンプト等の固定オーバーヘッドを毎回送るため、1件ずつ呼ぶと割高になる
// （実測: 本文1件 $0.032・入力13,000tok。本文自体は4,000tok程度）。
// 複数人分をまとめて1回で読み取り、固定費を人数で割る。
// 取り違え防止のため必ず番号を返させ、件数が合わなければ呼び出し側で個別処理に落とす。
export const BODY_FIELDS_BATCH_RULES = `あなたはSES営業メールの読み取り係です。
複数のメールを続けて渡します。**メールごとに独立して**読み取ってください。

厳守: あるメールの情報を別のメールの結果に混ぜないこと。番号は入力どおりに返すこと。

各メールについて、そのメールに登場する候補者(要員)の基本情報を転記します。
ルール:
- 書かれている値の転記のみ。推測で埋めない。記載がない項目は null
- name: 氏名・イニシャル表記そのまま / age: 数値 / gender: "男性"|"女性"|null
- station: 最寄駅名（路線名は含めてよい） / rate: 単価の表記そのまま
- availability: 稼働可能時期の表記そのまま（「即日〜」等）
- company: 送信元(所属営業)会社の正式名。宛先会社・挨拶の人名と混同しない
- employment: 所属の表記そのまま（「弊社正社員」等）
- 1つのメールに複数人いる場合は candidates 配列に全員分
- mailType: そのメールの種別。人材紹介なら "candidate"、案件紹介なら "project"、
  それ以外は "other"

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"results":[{"no":1,"mailType":"candidate","candidates":[{"name":"","age":null,"gender":null,"station":null,"rate":null,"availability":null,"company":null,"employment":null}]}]}

--- 以下、番号付きのメール本文 ---
`

export const PROJECT_FIELDS_RULES = `あなたはSES営業の案件紹介文の読み取り係です。以下のテキスト（メール本文または手入力）から案件情報を転記してください。

ルール:
- 書かれている値の転記のみ。推測で埋めない。記載がない項目は null（配列項目は []）
- title: 案件名・タイトルの表記そのまま（【】等の飾りは外してよい）。無ければ作業内容から20字以内で要約
- client: エンド企業・元請け企業名（記載時のみ。送信元の営業会社と混同しない）
- requiredSkills: 必須スキル・歓迎ではなく必須と読める技術名を1つずつ（見出し語・工程名は含めない）
- niceToHaveSkills: 尚可・歓迎・あれば尚良のスキル
- requiredSkillYears: 「Java 5年以上」等の年数条件がある技術のみ {"技術名":[年数]} 形式
- rateMin/rateMax: 月額単価の数値（万円）。「60〜70万」→ rateMin=60, rateMax=70。単一値なら両方に同じ値。時給・日額は null
- startDate: 開始時期の表記そのまま（「即日」「9月〜」「2026/10」等）
- workLocation: 勤務地・最寄駅の表記そのまま
- remotePolicy: リモート/出社に関する表記そのまま（「フルリモート」「週2出社」等）
- contractType: 商流・契約形態の表記そのまま（「請負」「準委任」「一社先」等）
- headcount: 募集人数の数値
- workload: 稼働率・稼働日数の表記そのまま（「週5」「100%」等）
- settlementMin/settlementMax: 精算幅の時間数値（「140-180h」→ 140, 180）
- roleSummary: 役割・ポジションの表記そのまま（「PM」「バックエンドエンジニア」等）
- industry: 業界の表記（「金融」「EC」等、記載時のみ）
- 複数案件が記載されている場合は projects 配列に全件分
- 読み取りに自信が持てない場合は confidence を "low" にする

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"projects":[{"title":"","client":null,"requiredSkills":[],"niceToHaveSkills":[],"requiredSkillYears":{},"rateMin":null,"rateMax":null,"startDate":null,"workLocation":null,"remotePolicy":null,"contractType":null,"headcount":null,"workload":null,"settlementMin":null,"settlementMax":null,"roleSummary":null,"industry":null}],"confidence":"high または low"}

--- 以下案件テキスト ---
`

export const BODY_FIELDS_RULES = `あなたはSES営業メールの読み取り係です。以下のメール本文から候補者(要員)の基本情報を転記してください。

ルール:
- 書かれている値の転記のみ。推測で埋めない。記載がない項目は null
- name: 氏名・イニシャル表記そのまま / age: 数値 / gender: "男性"|"女性"|null
- station: 最寄駅名（路線名は含めてよい） / rate: 単価の表記そのまま
- availability: 稼働可能時期の表記そのまま（「即日〜」等）
- company: 送信元(所属営業)会社の正式名。宛先会社・挨拶の人名と混同しない。「◯◯株式会社 △△です」は会社=◯◯株式会社
- employment: 所属の表記そのまま（「弊社正社員」「一社下正社員」等）
- 複数人が記載されている場合は candidates 配列に全員分
- mailType: このメールの種別。人材(要員・エンジニア)の紹介なら "candidate"、
  案件(仕事・プロジェクト)の紹介なら "project"、営業・お知らせ等どちらでもなければ "other"。
  案件メールには個人プロフィールが無く、案件名・必須スキル・募集人数・商流等が書かれている

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"mailType":"candidate または project または other","candidates":[{"name":"","age":null,"gender":null,"station":null,"rate":null,"availability":null,"company":null,"employment":null}]}

--- 以下メール本文 ---
`
