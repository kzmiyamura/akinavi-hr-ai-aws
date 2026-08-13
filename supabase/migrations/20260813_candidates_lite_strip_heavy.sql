-- マッチング1回の転送量を落とす。
--
-- 実測（2026-08-13、PowerShell 案件・全件モード）:
--   fetch_candidates_for_project(limit=500) → 319件 / 7.5MB / 11.5秒
--   うち raw_profile が 7.0MB（93%）。マッチングが実際に使うのは 1件 1.1KB だけ。
--   raw_profile の内訳は jsonRows 42.6% ＋ attachmentText 39.7% で 8 割超。
--   どちらも解析の中間生成物で、画面もマッチングも読んでいない
--   （src/ で参照しているのは _regex_backup だけ）。
--
-- そこで candidates_lite から重い中間生成物を落とす。
-- 詳細画面が全文を要るときは従来どおり fetch_candidate_raw_profile(id) で個別に取る。
--
-- 列名・型は変えないので CREATE OR REPLACE で差し替えられる
-- （DROP ... CASCADE すると fetch_candidates_for_project 等の RPC が巻き添えで消える）。
create or replace view candidates_lite as
select
  id,
  name,
  email,
  phone,
  skills,
  experience_years,
  desired_rate,
  from_company,
  resume_url,
  drive_url,
  box_url,
  box_status,
  created_at,
  updated_at,
  updated_by,
  duplicate_flag,
  merged_into,
  data_env,
  created_by,
  raw_profile
    - 'text'           -- メール本文全文
    - 'parsedGrid'     -- Excel パース済みグリッド
    - 'jsonRows'       -- Excel の行データ（解析中間物・42.6%）
    - 'attachmentText' -- 添付の抽出テキスト全文（39.7%）
    - 'pipeline_trace' -- 解析パイプラインのデバッグ記録
    - '_roleScores'    -- ロール判定の内部スコア
    as raw_profile
from candidates;

grant select on candidates_lite to anon, authenticated;
