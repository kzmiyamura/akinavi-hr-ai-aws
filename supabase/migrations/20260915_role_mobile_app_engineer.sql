-- 役割に「モバイルアプリエンジニア」を追加する（2026-09-15）。
--
-- ■ なぜ
--   ユーザー指摘「iOSエンジニアって書いてるやん」。
--   実際のPR文:
--     「iOSエンジニアとしてSwift・SwiftUIを中心に長年の開発経験を持ち、
--       基本設計から詳細設計、開発、レビュー、保守まで幅広く対応可能です。…
--       プロダクトオーナーやデザイナーとの企画検討、講師経験、リーダー経験もあり」
--   本番と同じ抽出器に通した結果は roles = ["プロジェクトリーダー"] だけだった。
--   末尾の「リーダー経験もあり」しか拾えていない。
--
--   原因は ROLE_DEFS に**モバイルが1つも無かった**こと。
--   エンジニア系は フロントエンド/バックエンド/フルスタック/インフラ/クラウド/データ/ML/テスト
--   の8種あるのに、iOS・Android だけ枠が無かった。
--
--   実測（prod 3,225人・2026-09-15）:
--     モバイル語（iOS/Android/Swift/Kotlin）あり           552人
--     モバイル開発を職種として書いている                    101人
--       うち製品系の役割がゼロ                              33人
--     「iOSエンジニア」等と職種名を名乗る                     8人
--       うち PL/PM/PMO 扱いになっていた                      7人   ← 今回の人はこれ
--
-- ■ 軸（docs/ROLE_DEFINITION.md が正）
--   作用対象 = 製品（作られるシステム・ソフトウェアそのもの）
--   権限     = 2（実行）
--   フロントエンド/バックエンドと同列。iOS と Android の差は**技術**であって役割ではないので
--   分けない（Swift / Kotlin は skill_master 側が持つ）。
--
-- ■ 触る場所（CLAUDE.md「役割の定義」）
--   このSQL / match-batch の ROLE_AXIS / inbound-email の ROLE_DEFS /
--   project_apply.mjs の ROLE_LABELS と prompts.mjs / MatchingPage の ROLE_FAMILIES_UI
--   ズレ検出は src/lib/__tests__/roleAffinityParity.test.ts と scripts/sql/test_role_affinity.sql

INSERT INTO role_axis (label, object, authority, note) VALUES
  ('モバイルアプリエンジニア', '製品', 2,
   'iOS/Android アプリを設計し実装する。iOSとAndroidの差は技術でありスキル側で持つ')
ON CONFLICT (label) DO UPDATE
  SET object = EXCLUDED.object, authority = EXCLUDED.authority, note = EXCLUDED.note;

-- 確認
SELECT label, object, authority FROM role_axis WHERE object = '製品' ORDER BY authority DESC, label;
