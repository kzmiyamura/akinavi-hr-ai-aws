-- 特定案件の必須スキルごとに「充足する prod 人材が何人いるか」を出す。
--
-- 必須スキルの語がそのままの表記でしか一致しないと、実質誰も満たさない要件ができる。
-- 例: EntraID は skill_master に無く、Azure AD（2023年に Entra ID へ改称）を持つ人材と
-- 結びついていなかった。skill_master を触る前後でここを比べる。
--
-- 判定は skill_hit_weights を通す。skill_satisfies を候補者×スキルで直接回すと
-- statement timeout する（1,700人×5スキルで打ち切られた）。
--
-- 対象案件は WHERE で指定する（既定: PowerShell→Azure Functions 移行案件）。
WITH req AS (
  SELECT jsonb_array_elements_text(required_skills) AS want
    FROM projects
   WHERE data_env = 'prod' AND id = '3d378a6f-b730-4091-ab57-a88621b4b0a0'
)
SELECT
  req.want AS 必須スキル,
  (SELECT count(*)
     FROM skill_hit_weights('prod', ARRAY[req.want], NULL::jsonb) h
    WHERE h.hit_w > 0)                       AS 充足人数,
  EXISTS (
    SELECT 1 FROM skill_master m
     WHERE lower(m.name) = lower(req.want)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.aliases) a
                    WHERE lower(a) = lower(req.want))
  )                                          AS マスタ登録あり
FROM req
ORDER BY 2 DESC;
