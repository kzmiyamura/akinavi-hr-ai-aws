-- 「メール通知で送った人」を人材一覧の印に出すための読み取り口。
--
-- 2026-10-20 営業の要望「後メール通知で送った印もあるといい」。
--
-- notification_log は service_role 専用（RLS でポリシーを1つも作っていない）。
-- この画面には認証が無く anon キーは公開されているので、**表をそのまま開けない**。
-- 送信先メールアドレス（sent_to）が入っているためなおさら。
--
-- そこで列を絞ったビューだけを公開する。ビューは所有者の権限で動くので、
-- 元の表の RLS はそのまま（service_role 以外は直接読めない）に保てる。
-- 公開するのは「誰に・いつ・どのルールで送ったか」の3つだけで、宛先は出さない。
--
-- 量: 本番実測（2026-10-20）で notification_log 246行・うち今いる人材は16人。
--     ルール名を行に入れても数KBなので、案件名のときのような繰り返しの害は無い。
CREATE OR REPLACE VIEW public.notification_marks AS
SELECT n.candidate_id,
       n.rule_id,
       r.label AS rule_label,
       n.sent_at
  FROM notification_log n
  LEFT JOIN notification_rules r ON r.id = n.rule_id;

COMMENT ON VIEW public.notification_marks IS
  '人材一覧の「通知済」の印に使う読み取り口。notification_log から宛先(sent_to)を落としたもの';

GRANT SELECT ON public.notification_marks TO anon, authenticated;
