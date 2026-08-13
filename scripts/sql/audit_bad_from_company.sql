-- 会社名として明らかにおかしい from_company を数える。
--
-- 人材メールには「・NG：株式会社◯◯（NRI）様」のように**就業したくない会社**を書く欄がある。
-- これを所属会社として登録していた（2026-08-13 実害）。ほかにも、英字社名が空白を跨げず
-- 頭が欠ける（「Next IT Consulting株式会社」→「Consulting株式会社」）事象がある。
SELECT
  CASE
    WHEN from_company ~ 'NG|ＮＧ|不可|お断り'          THEN '1. NG先を会社名にしている'
    WHEN from_company ~ '^[・･\-‐−ー:：、。\s]'          THEN '2. 記号や区切りで始まる'
    WHEN length(trim(from_company)) <= 2                 THEN '3. 短すぎる'
    WHEN from_company ~ '(様|御中|ご担当)$'              THEN '4. 敬称が残っている'
    ELSE                                                      '5. 一見問題なし'
  END                                              AS 区分,
  count(*)                                         AS 件数,
  string_agg(DISTINCT from_company, ' / ' ORDER BY from_company) FILTER (
    WHERE from_company ~ 'NG|ＮＧ|不可|お断り|^[・･\-‐−ー:：、。\s]'
       OR length(trim(from_company)) <= 2
       OR from_company ~ '(様|御中|ご担当)$'
  )                                                AS 例
FROM candidates
WHERE data_env = 'prod' AND merged_into IS NULL
  AND from_company IS NOT NULL AND from_company <> ''
GROUP BY 1
ORDER BY 1;
