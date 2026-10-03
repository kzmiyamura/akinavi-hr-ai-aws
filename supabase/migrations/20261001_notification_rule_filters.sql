-- ============================================================================
-- 通知ルールに「年齢・経験年数・スキル年数・到達レベル・本文キーワード」を足す
--   2026-10-01。現場の要求:
--     「基盤チームで募集するとしたら共通部品を作ったことがある経験と、
--       Java開発経験が必要、20代後半〜40代まで、教育が必要な人は難しい」
--
-- 追加前に prod 4,204人で埋まり具合を実測した（埋まっていない項目で絞ると
-- 該当0件のルールを作らせてしまうため）:
--   年齢              4,125人 98.1%   25〜49歳は 2,843人
--   経験年数          4,123人 98.1%   ただし5年以上が88%＝**単独では絞りにならない**
--   skillYears        2,896人 68.9%   Javaの年数がある人 1,094人
--   _roleLevels       2,152人 51.2%   延べ A982 / B1,865 / C276 / 裏付けなし482
--   経歴本文          3,182人 75.7%   「共通部品|共通基盤|フレームワーク開発」に108人
-- ============================================================================

ALTER TABLE notification_rules
  -- 年齢の範囲。null = 指定なし。「20代後半〜40代」は 25〜49 で表す
  ADD COLUMN IF NOT EXISTS age_min int,
  ADD COLUMN IF NOT EXISTS age_max int,
  -- 経験年数の下限。null = 指定なし
  ADD COLUMN IF NOT EXISTS experience_years_min int,
  -- skill_keywords に挙げた技術のうち、いずれか1つでこの年数以上あること。
  -- 「Java開発経験が必要」を「Javaを3年以上」として表すための条件
  ADD COLUMN IF NOT EXISTS skill_years_min int,
  -- 到達レベルが C（従事どまり）の印しか無い人を外す。
  -- ⚠ 「A/Bだけ通す」ではなく「Cしか無い人を外す」除外型にしてある。
  --   印が付くのは全体の51%しかないため、A/B必須にすると印の無い半分が全員落ちる。
  --   印の意味は docs/ROLE_DEFINITION.md 軸3 / src/lib/roleLevel.ts
  ADD COLUMN IF NOT EXISTS exclude_level_c boolean NOT NULL DEFAULT false,
  -- 経歴本文のキーワード（OR）。「共通部品」「共通基盤」など、
  -- スキル名では表せない実績を拾う
  ADD COLUMN IF NOT EXISTS text_keywords text[] NOT NULL DEFAULT '{}',
  -- 値が取れていない人材を通すか。既定は true（通す）。
  -- false にすると「年齢不明・経験年数不明・その技術の年数不明」を落とす。
  -- skillYears は31%、到達レベルは49%が未取得なので、既定で落とすと取りこぼす
  ADD COLUMN IF NOT EXISTS include_unknown boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN notification_rules.age_min IS '年齢の下限（null=指定なし）';
COMMENT ON COLUMN notification_rules.age_max IS '年齢の上限（null=指定なし）';
COMMENT ON COLUMN notification_rules.experience_years_min IS '経験年数の下限。実測で5年以上が88%なので単独では絞りにならない';
COMMENT ON COLUMN notification_rules.skill_years_min IS 'skill_keywords のいずれかでこの年数以上（null=指定なし）';
COMMENT ON COLUMN notification_rules.exclude_level_c IS '到達レベルCの印しか無い人を外す。印のない人は include_unknown に従う';
COMMENT ON COLUMN notification_rules.text_keywords IS '経歴本文のキーワード（OR）。共通部品・共通基盤など';
COMMENT ON COLUMN notification_rules.include_unknown IS '値が取れていない人材を通すか（既定 true）';

-- 年齢の上下限が逆に入るのを防ぐ（画面で入れ違えると常に0件になり、原因が分からなくなる）
ALTER TABLE notification_rules
  DROP CONSTRAINT IF EXISTS notification_rules_age_range_chk;
ALTER TABLE notification_rules
  ADD CONSTRAINT notification_rules_age_range_chk
  CHECK (age_min IS NULL OR age_max IS NULL OR age_min <= age_max);
