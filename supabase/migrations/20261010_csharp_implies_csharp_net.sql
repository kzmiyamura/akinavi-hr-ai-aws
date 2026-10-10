-- 「C#」と書いた人が「C#.NET」要件から丸ごと落ちていた（2026-10-10・Issue #188 の調査中に発見）
--
-- ■ 何が起きていたか
--   `C#` と `C#.NET` は skill_master の**別の行**で、包含関係も無かった。
--     ・canon('C#') = 'c#' ≠ canon('C#.NET') = 'c#.net'
--     ・判定③（語境界一致）は「候補者のスキルが必須スキルを**含む**」向きなので
--       'c#' は 'c#.net' を含まない。逆（C#.NET を持つ人が C# 要件を満たす）は成立していた
--   つまり **要件を `C#.NET` と書くと、`C#` と書いている人は全員落ちる**。
--
--   別行にしたのは `20260529_add_csharp_net_skill.sql` で、理由は**抽出側の都合**だった
--   （inbound-email の C# パターンに「直後が . なら不一致」の否定先読みがあるため、
--   "C#.net" を拾う行が必要だった）。マッチングの意味として分けたわけではない。
--
-- ■ 実測（prod・2026-10-10。件数だけ引いた）
--   prod 人材 1,915人のうち
--     C# 要件を満たす         514人
--     C#.NET 要件を満たす      63人
--     **C# は満たすが C#.NET は満たさない 451人**（C#技術者の88%）
--   Issue #187 / #188 の案件「販売管理システム（C#・VB.NET）保守・改善」の必須スキルは
--   `[基本設計, C#.NET]`（重み C#.NET=4 / 基本設計=2）。基本設計は汎用スキルなので
--   資格判定は C#.NET だけで決まり、**63人の中から順位を付けていた**。
--   母集団が8分の1になると、順位は C# の深さではなく勤務地・単価で決まる。
--   #188「C#.NET の経験がない人が1位になる」が起きる土台はこれ。
--
-- ■ 入れないもの（測った上で捨てた）
--   ・`vb.net` → `c#.net` … VB.NET は別言語。257人が誤って C# 案件に入る
--   ・`asp.net` → `c#.net` … ASP.NET は VB でも書ける。165人が対象になるが言い切れない
--   ・`.net framework` → `c#.net` … 同上（言語を特定しない）
--   必要になったら営業判断を取ってから足す。

INSERT INTO skill_implications (child, parent, note) VALUES
  ('c#', 'c#.net',
   'C# は .NET 上の言語。C# 経験者は C#.NET 要件を満たす（逆は語境界一致で既に成立）。'
   '2026-10-10 実測で prod 1,915人中 451人がこの1行で救われる')
ON CONFLICT (child, parent) DO NOTHING;

-- 確認（`supabase db query -f` は最後の文の結果だけを返す）
SELECT
  skill_satisfies('C#', 'C#.NET')          AS "C#→C#.NET（trueになったか）",
  skill_satisfies('C#.NET', 'C#')          AS "C#.NET→C#（元からtrue）",
  skill_satisfies('VB.NET', 'C#.NET')      AS "VB.NET→C#.NET（falseが正しい）",
  skill_satisfies('C', 'C#.NET')           AS "C→C#.NET（falseが正しい）",
  (SELECT count(*) FROM skill_hit_weights('prod', ARRAY['C#.NET'], NULL))
    AS "C#.NET充足人数（63→514になるはず）",
  (SELECT count(*) FROM skill_hit_weights('prod', ARRAY['C#'], NULL))
    AS "C#充足人数（514のまま）",
  (SELECT count(*) FROM fetch_candidates_for_project(
     'prod'::text, ARRAY['基本設計','C#.NET']::text[],
     NULL::numeric, 75::numeric, '大阪府 淀屋橋'::text, NULL::text, 3000,
     40, 15, 15, 20, 10, false, NULL::text, '大阪府'::text, NULL::integer,
     '{"C#.NET":4,"基本設計":2}'::jsonb, NULL::text[]))
    AS "販売管理案件の候補人数";
