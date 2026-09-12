-- candidates_lite から「一覧で使わない重いキー」を落とす（egress 対策）。
--
-- ■ 何が起きていたか
--   このビューは 2026-06-09 に egress 対策として作られ、raw_profile から
--   'text' と 'parsedGrid' を落としていた。ところがその後 raw_profile に
--   重いキーが追加されたのに、**落とす側のリストは更新されていなかった**。
--
--   実測（2026-09-12・prod 200件）: 1行 18,280 bytes のうち
--     jsonRows        8,112 B  46.3%   ← 追加されたが strip されていない
--     attachmentText  6,452 B  36.8%   ← 同上（CLAUDE.md が「取るな」と書いている当の中身）
--     pipeline_trace    672 B   3.8%
--     skillsByCategory  519 B   3.0%   ← 画面で使う。残す
--     skillYears        423 B   2.4%   ← 画面で使う。残す
--   この2キーだけで **83%** を占めていた。8月の記録では 3.8KB/行だったので5倍に太っている。
--
-- ■ 効果（実測値からの計算）
--   人材モード一覧 50件   1,392 KB → 約 210 KB
--   案件1クリック 10件      194 KB → 約  33 KB
--
-- ■ 落として安全な根拠
--   src/ 配下の参照数を数えた（2026-09-12）:
--     jsonRows 0 / attachmentText 0（コメント1件のみ）/ pipeline_trace 0 /
--     _roleScores 0 / _industryScores 0 / allParsedAttachmentLabels 0 /
--     hfDetectedMissingSkills 0
--   _regex_backup は AiAppliedNote が使っているので**残す**（113 B と小さい）。
--   詳細画面は candidates 本体（fetchCandidateById / fetch_candidate_raw_profile）を
--   読むので、ここで落としても中身は見られる。
--
-- ■ DROP しない
--   このビューには6つの関数が依存しており、DROP すると壊れる（2026-08-31 に実際に壊した）。
--   列名も型も変えないので CREATE OR REPLACE で差し替わる。

CREATE OR REPLACE VIEW candidates_lite AS
SELECT
  id, name, email, phone, skills, experience_years, desired_rate,
  from_company, resume_url, drive_url, box_url, box_status,
  created_at, updated_at, updated_by, duplicate_flag, merged_into, data_env, created_by,
  (raw_profile
     - 'text'                       -- メール本文（平均6KB）
     - 'parsedGrid'                 -- 旧グリッド
     - 'jsonRows'                   -- Excelのグリッド行（8.1KB・一覧では未使用）
     - 'attachmentText'             -- 経歴書の中身（6.5KB・一覧では未使用）
     - 'pipeline_trace'             -- 取り込みの経路ログ（デバッグ用）
     - '_roleScores'                -- 役割スコアの内訳（監査用）
     - '_industryScores'            -- 業界スコアの内訳（監査用）
     - 'allParsedAttachmentLabels'  -- 添付名の一覧（詳細でのみ使う）
     - 'hfDetectedMissingSkills'    -- 突合の中間結果
  ) AS raw_profile,
  bookmarked
FROM candidates;

GRANT SELECT ON candidates_lite TO anon, authenticated;

COMMENT ON VIEW candidates_lite IS
  '一覧・マッチング用の軽量ビュー。raw_profile から一覧で使わない重いキーを落としてある。
   **raw_profile にキーを足したら、重いものはここにも足すこと**（足し忘れて5倍に太った前例あり・2026-09-12）。
   詳細が要るときは candidates 本体か fetch_candidate_raw_profile(id) を使う。';
