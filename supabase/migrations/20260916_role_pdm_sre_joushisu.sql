-- 役割に「プロダクトマネージャー」「SRE」「社内SE」を追加する（2026-09-16）。
--
-- ■ どうやって選んだか
--   ユーザーから世の中のIT職種150種超の一覧を提示された。**全部は足さない。**
--   docs/ROLE_DEFINITION.md の原則は「実データで分かれる分だけ分ける」。
--   ラベルを増やすと role_affinity のマスが増えるだけで、中身が無ければ死にラベルになる
--   （MLエンジニアは prod 実測2人。すでにその状態に近い）。
--
--   そこで2つの条件を両方満たすものだけを足した:
--     (1) ローカル控え（D:\akinavi-archive\mail 7,342通）に**職種名として実在する**
--     (2) 既存20ラベルが埋めていない **作用対象 × 権限 の空きマス**に入る
--
--   実測（控え7,342通・2026-09-16 / scripts/audit_role_coverage.mjs）:
--     候補                実在   いま付いている役割
--     社内SE/情シス        340通  システムエンジニア153 / ヘルプデスク142 に割れる
--     プロダクトマネージャー 109通  プロジェクトマネージャー50（対象違い）
--     SRE                  66通  運用保守23 / インフラエンジニア18 に散る
--
-- ■ 軸（docs/ROLE_DEFINITION.md が正）
--   プロダクトマネージャー  製品   / L4  ← 製品×4 は空きマスだった
--     根拠: PM は「このPJのQCD（成果）」に、PdM は「何を作るか（製品）」に責任を持つ。
--           PMO×PM のときと同じ「対象が違う」構図。プロダクトオーナーも同じマス
--           （Scrum Guide: 製品価値の最大化に責任を持つ）なので別ラベルにしない。
--   SRE                    サービス / L3  ← サービス×3 は空きマスだった
--     根拠: Google SRE のエラーバジェット方針は「信頼性が枯れたらリリースを止める」
--           判断権を持つ。運用保守(L2)より1段上。予算・契約の決裁は持たないので L4 ではない。
--   社内SE                 事業     / L2  ← 事業×2 は空きマスだった
--     根拠: 受託で他社の製品を作る SE とも、他社サービスの窓口である ヘルプデスク とも違い、
--           **自社の業務・IT資産**に働きかける。ITSS でいう社内IT部門の立場。
--
-- ■ 足さなかったもの（理由つき・再検討のため残す）
--   ・ERPコンサル(621通)・仮想化(569)・LLM/生成AI(1,180)・ゲーム(247)・組み込み(103) 等は
--     **技術・領域の違い**であって作用対象×権限は既存と同じマス。skill_master 側が持つ
--     （実測で 生成AI・LLM・RAG・Kubernetes・Unity・Solidity 等は辞書に登録済み）
--   ・テクニカルライター(591通)は regex が「マニュアル作成」を拾っているだけで、
--     これは 問い合わせ対応 と同じ**作業語**。職種としての言及は稀
--   ・DBA(89通)・ネットワーク(47)・サーバ(40)は 製品×2 で インフラエンジニア と同じマス
--   ・セキュリティエンジニア は職種名としては13通しかなく、かつ作用対象が
--     製品とサービスに跨って定まらない。**数が増えてから**設計する
--
-- ■ 触る場所（CLAUDE.md「役割の定義」）
--   このSQL / match-batch の ROLE_AXIS / inbound-email の ROLE_DEFS /
--   project_apply.mjs の ROLE_LABELS と prompts.mjs / MatchingPage の ROLE_FAMILIES_UI
--   ズレ検出は src/lib/__tests__/roleAffinityParity.test.ts と scripts/sql/test_role_affinity.sql

INSERT INTO role_axis (label, object, authority, note) VALUES
  ('プロダクトマネージャー', '製品', 4,
   'PMは成果(QCD)に、PdMは製品(何を作るか)に責任を持つ。プロダクトオーナーも同じマス'),
  ('SRE', 'サービス', 3,
   'Google SRE。エラーバジェットでリリース可否を判断する。運用保守(L2)より1段上'),
  ('社内SE', '事業', 2,
   '自社の業務・IT資産に働きかける社内IT部門。受託のSEでもヘルプデスクでもない')
ON CONFLICT (label) DO UPDATE
  SET object = EXCLUDED.object, authority = EXCLUDED.authority, note = EXCLUDED.note;

-- 確認: 作用対象 × 権限 のマスがどれだけ埋まったか
SELECT object AS 作用対象, authority AS 権限, string_agg(label, ' / ' ORDER BY label) AS 役割
FROM role_axis GROUP BY object, authority ORDER BY 1, 2 DESC;
