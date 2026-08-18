-- 誤検知で隔離された人材を一覧に戻す（2026-08-19）
--
-- 原因: Haiku が人材紹介メールを mailType='other' と誤判定し、
-- 隔離の第2条件（AI が返した人物に使える氏名が無い）が第1条件の副産物だったため
-- 二重チェックが機能していなかった。
--
-- 戻すのは「件名が人材紹介だと明言している」もののみ。
-- 営業の定期配信・案件メール（Trinitas / 会計パッケージ）は隔離のままにする。
BEGIN;

UPDATE candidates
   SET merged_into = NULL,
       raw_profile = raw_profile - '_quarantine'
 WHERE data_env = 'prod'
   AND raw_profile ? '_quarantine'
   AND raw_profile->>'subject' ~ '直人材|弊社社員|弊社\s*FL|人材一覧|要員一覧|人材情報|要員情報';

COMMIT;

SELECT '一覧に戻した件数（残り隔離中の数で確認）' AS 指標, count(*)::text AS 値
FROM candidates WHERE data_env='prod' AND raw_profile ? '_quarantine'
UNION ALL
SELECT '  内訳: 件名', string_agg(DISTINCT left(coalesce(raw_profile->>'subject','(なし)'), 30), ' / ')
FROM candidates WHERE data_env='prod' AND raw_profile ? '_quarantine';
