-- 所属会社の汚れを直す（2026-08-17）
--
-- ① 宛先である当社名（株式会社ボイス）が所属会社に入っていた 18件
-- ② regex の誤値「株式会社CyTechから社名変更になります」がそのまま残っていた 3件
-- ③ 敬称付き・別会社（株式会社ベリサーブ様）が入っていた 1件
--
-- 正しい社名は送信元ドメインで決める:
--   ai-more.co.jp → 株式会社ai・more（署名の「株式会社ai・more(株式会社CyTechから社名変更になります。)」より）
--   n-ic.jp       → Next IT Consulting株式会社
--
-- agent_companies（ドメイン→社名の対応表）にも同じ誤値が入っていたので合わせて直す。
BEGIN;

-- ドメイン対応表の修正
UPDATE agent_companies
   SET company_name = '株式会社ai・more'
 WHERE domain = 'ai-more.co.jp'
   AND company_name LIKE '%社名変更%';

-- 人材側の修正（送信元ドメインから正しい社名を引き直す）
UPDATE candidates c
   SET from_company = '株式会社ai・more'
 WHERE c.data_env = 'prod' AND c.merged_into IS NULL
   AND split_part(c.raw_profile->>'from', '@', 2) = 'ai-more.co.jp'
   AND (c.from_company ILIKE '%ボイス%' OR c.from_company ILIKE '%社名変更%');

UPDATE candidates c
   SET from_company = 'Next IT Consulting株式会社'
 WHERE c.data_env = 'prod' AND c.merged_into IS NULL
   AND split_part(c.raw_profile->>'from', '@', 2) = 'n-ic.jp'
   AND c.from_company ~ '(様|御中)$';

COMMIT;

-- 確認: 汚れが残っていないか
SELECT '当社名が残っている人材' AS 指標, count(*)::text AS 値
FROM candidates
WHERE data_env='prod' AND merged_into IS NULL
  AND (from_company ILIKE '%ボイス%' OR from_company ILIKE '%i-voice%'
    OR from_company ILIKE '%アキナビ%' OR from_company ILIKE '%akinavi%')
UNION ALL
SELECT '「社名変更」が残っている人材', count(*)::text
FROM candidates
WHERE data_env='prod' AND merged_into IS NULL AND from_company ILIKE '%社名変更%'
UNION ALL
SELECT '敬称付きが残っている人材', count(*)::text
FROM candidates
WHERE data_env='prod' AND merged_into IS NULL AND from_company ~ '(様|御中)$'
UNION ALL
SELECT 'ai・more 所属になった人材', count(*)::text
FROM candidates
WHERE data_env='prod' AND merged_into IS NULL AND from_company = '株式会社ai・more';
