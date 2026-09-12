-- Box 取込を「人が押さなくても回り、失敗したら理由が残り、無駄に再試行しない」形にする。
--
-- ■ 直す前の問題（2026-09-12 実測）
--   1. 失敗理由が pm2 のログにしか残らない。画面からは「失敗」としか分からない
--   2. 同じ人を毎日404で再試行していた。原因は inbound-email が再登録のたびに
--      box_status を無条件で 'pending' に戻していたこと（同じ人材が毎日再送されてくる）
--   3. 自動取込の条件が「経歴書がまだ無い人」だけで、12人全員が対象外のまま
--      永久に処理されない状態だった（画面には「処理待ち」と出ていた）
--
-- ■ 足す列
--   box_error    … 失敗理由。画面に出して、ログを見なくても分かるようにする
--   box_attempts … 試行回数。増えすぎたら止める
--   box_tried_at … 最終試行時刻。間隔を空けて再試行するため
--
--   404 や「DL許可なし」は**何度やっても直らない**ので、その場で打ち切る（attempts を上限へ）。
--   通信エラーのような一時的な失敗だけ、間隔を空けて数回だけ再試行する。

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS box_error    text,
  ADD COLUMN IF NOT EXISTS box_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS box_tried_at timestamptz;

COMMENT ON COLUMN candidates.box_error IS
  'Box取込の失敗理由（人が読む用）。404・DL許可なしは恒久的な失敗なので再試行しない';
COMMENT ON COLUMN candidates.box_attempts IS
  'Box取込の試行回数。BOX_MAX_ATTEMPTS 以上で打ち切る。恒久的な失敗は即座に上限へ飛ばす';
COMMENT ON COLUMN candidates.box_tried_at IS
  'Box取込の最終試行時刻。一時的な失敗のときだけ、間隔を空けて再試行するのに使う';

-- 取込キューの取り出しが毎回フルスキャンにならないように
CREATE INDEX IF NOT EXISTS idx_candidates_box_queue
  ON candidates (box_status, box_attempts, box_tried_at)
  WHERE box_url IS NOT NULL;

-- いま失敗している6件に、ログから分かっている理由を入れておく
-- （毎日404を繰り返していたもの。ここで打ち切って再試行を止める）
UPDATE candidates
   SET box_error    = COALESCE(box_error, '共有リンクが存在しない（box page 404）'),
       box_attempts = GREATEST(box_attempts, 99),
       box_tried_at = COALESCE(box_tried_at, now())
 WHERE box_status = 'failed';
