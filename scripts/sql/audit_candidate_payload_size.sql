-- 再解析で 546（WORKER_RESOURCE_LIMIT）になる人材の入力サイズを見る（2026-08-12）
--
-- bulk_replay は raw_profile.text をそのまま inbound-email に投げ直す。
-- 本文が極端に長いと Edge Function 側の処理が重くなる。
--
-- 実行: npx supabase db query --linked -f scripts/sql/audit_candidate_payload_size.sql

SELECT left(name, 12)                                   AS 氏名,
       length(raw_profile->>'text')                     AS 本文の文字数,
       length(raw_profile->>'attachmentText')           AS 添付テキストの文字数,
       jsonb_array_length(COALESCE(raw_profile->'parsedGrid', '[]'::jsonb)) AS グリッド行数,
       right(resume_url, 28)                            AS 経歴書
  FROM candidates
 WHERE id IN ('2d131015-d64e-4457-98db-54dedb06ce7b')   -- M.S（3回とも546で失敗）
UNION ALL
-- 比較用: 直近の prod 人材の本文長の分布
SELECT '（比較）中央値', percentile_disc(0.5) WITHIN GROUP (ORDER BY length(raw_profile->>'text'))::int,
       NULL, NULL, NULL
  FROM candidates WHERE data_env = 'prod' AND raw_profile->>'text' IS NOT NULL
UNION ALL
SELECT '（比較）最大', max(length(raw_profile->>'text')), NULL, NULL, NULL
  FROM candidates WHERE data_env = 'prod' AND raw_profile->>'text' IS NOT NULL;
