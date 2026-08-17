-- 所属会社が汚れている人材と、正しい社名の候補を並べる（2026-08-17）
-- 候補は agent_companies（ドメイン→社名）から引く。無ければ null にする方針。
SELECT c.name,
       c.from_company AS 現在の値,
       split_part(c.raw_profile->>'from', '@', 2) AS 送信元ドメイン,
       coalesce(a.company_name, '(マッピングなし → null にする)') AS 正しい社名,
       count(*) OVER () AS 総件数
FROM candidates c
LEFT JOIN agent_companies a ON a.domain = split_part(c.raw_profile->>'from', '@', 2)
WHERE c.data_env='prod' AND c.merged_into IS NULL
  AND (c.from_company ILIKE '%ボイス%' OR c.from_company ILIKE '%i-voice%'
    OR c.from_company ILIKE '%アキナビ%' OR c.from_company ILIKE '%akinavi%'
    OR c.from_company ILIKE '%社名変更%'
    OR c.from_company ~ '(様|御中)$')
ORDER BY 送信元ドメイン, c.name;
