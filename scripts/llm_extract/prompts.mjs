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
- station: 最寄「駅名」だけ。路線名・曜日・徒歩分数・注記は含めない
- rate: 単価の表記そのまま。範囲は範囲のまま落とさない（「61～65万円」→「61～65万円」）
- availability: 稼働可能時期の表記そのまま（「即日〜」等）
- company: 送信元(所属営業)会社の正式名。宛先会社・挨拶の人名と混同しない
- employment: 所属の表記そのまま（「弊社正社員」等）
- employmentType: "正社員"|"契約社員"|"派遣社員"|"業務委託"|"フリーランス" のいずれか、無ければ null
- commercialFlow: "自社" または "N社先"、無ければ null。employmentType と混ぜない
- experienceYears: 本人の「総経験年数」として明示された数値(年)のみ。
  「業界6年目です」→6 /「IT経験15年」→15。特定案件・特定業務だけの年数は含めない。
  明示がなければ null。推測・合算はしない
- skillYears: 技術ごとの経験年数が明記されている場合のみ {"技術名": 年数}。
  「Javaを5年、PHPは3年程度」→{"Java":5,"PHP":3}。該当なしなら {}
- 1つのメールに複数人いる場合は candidates 配列に全員分
- mailType: そのメールの種別。人材紹介なら "candidate"、案件紹介なら "project"、
  それ以外は "other"

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"results":[{"no":1,"mailType":"candidate","candidates":[{"name":"","age":null,"gender":null,"station":null,"rate":null,"availability":null,"company":null,"employment":null,"employmentType":null,"commercialFlow":null,"experienceYears":null,"skillYears":{}}]}]}

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

// 案件条件の「解釈」（転記ではない）。登録時に1回だけ回す（2026-08-13 ユーザー合意）。
// 背景: 「Windows/Azure/M365 という Microsoft 知識全般を問う案件」は単語一致では拾えず、
// 辞書拡充でも本質に届かなかった（HANDOFF.md §0）。スコア計算はルールのままにして、
// AIには①複数名前提かどうか ②本文が暗に求める関連スキル、の2点だけ解釈させる。
export const PROJECT_INTERPRET_RULES = `あなたはSES案件のマッチング条件を解釈する係です。以下の案件テキストを読んで2点だけ判断してください。

1. multiPerson: この案件は複数名の募集で、かつ「チーム全体でスキル要件を満たせばよい」
   （1人が全要件を満たす必要はない）と読めるか。
   - 「2名セット」「複数名で補完可」「チームで対応」等の記載があれば true
   - 単に募集人数が2名以上なだけ（各自が全要件を満たす前提）なら false
   - evidence に判断根拠になった本文の表現をそのまま短く引用（true のときのみ・50字以内）

2. relatedSkills: 必須・尚可として明記されていないが、この案件の業務内容から
   「持っていれば強い」と読める具体的な技術名。
   - 例: Windows Server 運用 + Azure + M365 の案件なら Active Directory, Intune, Exchange Online
   - 本文に書いてある技術の言い換え・別名は入れない（それは転記であって解釈ではない）
   - 工程名（基本設計・テスト等）・抽象語（クラウド・インフラ等）は入れない
   - 各スキルに reason（なぜ関連するか・30字以内）を付ける
   - 自信のあるものだけ最大8件。無ければ []

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"multiPerson":false,"evidence":null,"relatedSkills":[{"name":"","reason":""}],"confidence":"high または low"}

--- 以下案件テキスト ---
`

export const BODY_FIELDS_RULES = `あなたはSES営業メールの読み取り係です。以下のメール本文から候補者(要員)の基本情報を転記してください。

ルール:
- 書かれている値の転記のみ。推測で埋めない。記載がない項目は null
- name: 氏名・イニシャル表記そのまま / age: 数値 / gender: "男性"|"女性"|null
- station: 最寄「駅名」だけ。路線名・曜日・徒歩分数・注記は含めない
  （「月～都営大江戸線　西新宿五丁目駅」→「西新宿五丁目駅」）
- rate: 単価の表記そのまま。範囲は範囲のまま落とさない（「61～65万円」→「61～65万円」）
- availability: 稼働可能時期の表記そのまま（「即日〜」等）
- company: 送信元(所属営業)会社の正式名。宛先会社・挨拶の人名と混同しない。「◯◯株式会社 △△です」は会社=◯◯株式会社
- employment: 所属の表記そのまま（「弊社正社員」「一社下正社員」等）
- employmentType: 雇用形態。次のいずれか1つ、無ければ null。表記を寄せて返す
  "正社員" | "契約社員" | "派遣社員" | "業務委託" | "フリーランス"
  （「弊社正社員」→正社員 /「個人事業主」→フリーランス /「SES」→正社員）
- commercialFlow: 商流の位置。"自社" または "N社先"（Nは数字）、無ければ null
  （「弊社社員」→自社 /「一社下」「1社先」→1社先 /「二次請け」→2社先）
  ※ employmentType と混ぜないこと。「1社先個人事業主」は
    commercialFlow="1社先", employmentType="フリーランス" と分けて返す
- experienceYears: 本人の「総経験年数」として明示された数値(年)のみ。
  「業界6年目です」→6 /「IT経験15年」→15 /「経験年数：8年」→8。
  特定案件・特定業務だけの年数（「Javaを3年」「金融で2年」等）は含めない。
  明示がなければ null。推測・合算はしない（計算はJS側で行う）
- skillYears: 技術ごとの経験年数が本文に明記されている場合のみ {"技術名": 年数} 形式。
  「Javaを5年、PHPは3年程度」→{"Java":5,"PHP":3} /「Java(10年以上)」→{"Java":10}。
  技術名は本文の表記そのまま。年数の記載がない技術は入れない。
  該当なしなら {}。工程名(要件定義/テスト等)・業種名は入れない
- 複数人が記載されている場合は candidates 配列に全員分
- mailType: このメールの種別。人材(要員・エンジニア)の紹介なら "candidate"、
  案件(仕事・プロジェクト)の紹介なら "project"、営業・お知らせ等どちらでもなければ "other"。
  案件メールには個人プロフィールが無く、案件名・必須スキル・募集人数・商流等が書かれている

出力は次のJSONのみ（説明文・コードフェンス禁止）:
{"mailType":"candidate または project または other","candidates":[{"name":"","age":null,"gender":null,"station":null,"rate":null,"availability":null,"company":null,"employment":null,"employmentType":null,"commercialFlow":null,"experienceYears":null,"skillYears":{}}]}

--- 以下メール本文 ---
`
