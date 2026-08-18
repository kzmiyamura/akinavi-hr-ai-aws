-- 隔離の原因が AI 側か regex 側かを切り分ける（2026-08-19）
--
-- 隔離条件（shadow_worker.mjs:292）は次の2つが同時に成立したとき:
--   ① AI（Haiku）が mailType != 'candidate' と判定
--   ② isUsableName（regex 側の判定）を通る氏名が1人もいない
-- llm_shadow.body_fields に AI が返した人物配列が残っているので、
-- 「AI が人を1人も返さなかった」のか「返したが regex が名前を認めなかった」のかが分かる。
SELECT c.name AS 登録名,
       left(coalesce(c.raw_profile->>'subject',''), 28) AS 件名,
       coalesce(jsonb_array_length(s.body_fields)::text, '(ログ無)') AS AIが返した人数,
       coalesce(s.body_fields->0->>'name', '-') AS AIが返した氏名,
       coalesce(c.raw_profile->'_quarantine'->>'detail', '-') AS 隔離理由
FROM candidates c
LEFT JOIN llm_shadow s ON s.candidate_id = c.id AND s.source = 'body'
WHERE c.data_env='prod' AND c.raw_profile ? '_quarantine'
ORDER BY c.created_at DESC;
