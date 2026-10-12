-- 通知ルールに「雇用形態」「商流」の選択条件を足す（2026-10-12）
--
-- 営業の要望「メール通知に自社正社員とか選択形式にできる？」。
-- 「自社正社員」は1つの値ではなく **商流=自社 × 雇用形態=正社員** の組み合わせなので、
-- 2軸に分けて複数選択できるようにする（軸の中は OR、軸どうしは AND）。
--
-- ■ prod 実測（1,903人・2026-10-12。組み合わせの多い順）
--     自社 × フリーランス   631人
--     自社 × 正社員         352人   ← これが「自社正社員」
--     1社先 × 正社員        294人
--     未取得 × 未取得       277人
--     1社先 × フリーランス  131人
--     自社 × 契約社員       113人
--     1社先 × 未取得         54人
--     自社 × 派遣社員        18人 / 1社先 × 契約社員 15人 / 自社 × 業務委託 7人
--
--   取得率: 雇用形態 82.6%（1,571/1,903）・商流 85.0%（1,618/1,903）
--
-- ■ 取得率が100%でないことの扱い
--   既存の `include_unknown`（既定 true）に乗せる。**既定では未取得の人も通知する**。
--   雇用形態は17.4%が未取得なので、既定で落とすと「正社員を選んだら
--   取りこぼしが17%増えた」が静かに起きる（skill_years_min で同じ失敗をしている）。
--
-- ■ 商流の値
--   実データは `自社` と `N社先`（今は 1社先 だけ）。
--   選択肢は 自社 / 1社先 / 2社先以降 の3つに丸める。判定は match.ts の flowBucket に
--   1つだけ置く（文字列比較を画面と Edge Function の両方に書くとズレる）。

ALTER TABLE notification_rules
  ADD COLUMN IF NOT EXISTS employment_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS commercial_flows text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN notification_rules.employment_types IS
  '雇用形態（正社員/フリーランス/契約社員/派遣社員/業務委託）。空=指定なし。
   複数選べて中は OR。prod 実測で82.6%しか取れていないため、未取得の人を
   通すかは include_unknown に従う（2026-10-12）';

COMMENT ON COLUMN notification_rules.commercial_flows IS
  '商流（自社/1社先/2社先以降）。空=指定なし。複数選べて中は OR。
   「自社正社員」は employment_types=正社員 と併せて指定する（prod 352人）。
   prod 実測で85.0%しか取れていないため未取得の扱いは include_unknown に従う（2026-10-12）';

-- 確認（`supabase db query -f` は最後の文の結果だけを返す）
SELECT column_name AS 列, data_type AS 型, column_default AS 既定
  FROM information_schema.columns
 WHERE table_name = 'notification_rules'
   AND column_name IN ('employment_types', 'commercial_flows')
 ORDER BY column_name;
