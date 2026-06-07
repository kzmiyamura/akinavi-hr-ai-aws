-- candidates_lite ビューを最小化: raw_profile から一覧カードで必要な
-- skillsByCategory のみを抽出する。
-- 転送量を削減（従来: ~1-5KB/行 → 改善後: ~200-500B/行）
--
-- 詳細表示時は fetch_candidate_raw_profile RPC で full raw_profile を別途取得する
-- (src/pages/CandidatePage.tsx の fullRawProfile useQuery 参照)

DROP VIEW IF EXISTS candidates_lite CASCADE;

CREATE VIEW candidates_lite AS
SELECT
  id, name, email, phone, skills, experience_years, desired_rate,
  from_company, resume_url, drive_url, box_url, box_status,
  created_at, updated_at, duplicate_flag, merged_into, data_env, created_by,
  jsonb_build_object(
    'skillsByCategory', raw_profile->'skillsByCategory'
  ) AS raw_profile
FROM candidates;

-- RLS の代わりに anon / authenticated ロールに SELECT を付与
GRANT SELECT ON candidates_lite TO anon, authenticated;
