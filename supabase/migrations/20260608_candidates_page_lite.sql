-- candidates テーブルの一覧取得を高速化するため、
-- raw_profile から重いフィールド（text・parsedGrid）を除いたビューと
-- 詳細取得用 RPC を作成する。
-- text  : メール全文（1~10KB/件 × 100件/ページ = 1MB+）
-- parsedGrid: Excel解析データ（HF Spaces 専用・UI 不使用）
-- 詳細表示時は fetch_candidate_raw_profile RPC で full raw_profile を別途取得する。

-- 既存のビュー・RPC を削除してから作成
DROP VIEW IF EXISTS candidates_lite CASCADE;
DROP FUNCTION IF EXISTS fetch_candidate_raw_profile(uuid);

-- 一覧用軽量ビュー（text・parsedGrid を除外）
CREATE VIEW candidates_lite AS
SELECT
  id, name, email, phone, skills, experience_years, desired_rate,
  from_company, resume_url, drive_url, box_url, box_status,
  created_at, updated_at, duplicate_flag, merged_into, data_env, created_by,
  (raw_profile - 'text' - 'parsedGrid') AS raw_profile
FROM candidates;

-- RLS の代わりに anon / authenticated ロールに SELECT を付与
GRANT SELECT ON candidates_lite TO anon, authenticated;

-- 詳細表示用: 特定 ID の raw_profile 全体（text・parsedGrid を含む）を返す
CREATE OR REPLACE FUNCTION fetch_candidate_raw_profile(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT raw_profile FROM candidates WHERE id = p_id LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION fetch_candidate_raw_profile(uuid) TO anon, authenticated;
