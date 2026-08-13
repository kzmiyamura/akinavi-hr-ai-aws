-- anon ロールの statement_timeout を 3秒 → 15秒 に引き上げる
--
-- 背景:
--   本アプリは認証なしで anon ロールのまま PostgREST を叩く。
--   Supabase の既定は anon=3秒 / authenticated=8秒 で、anon だけが極端に短い。
--   マッチングの fetch_candidates_for_project は高速化後でも 3.2秒かかるため
--   （内訳: skill_hit_weights 0.77秒 + candidates_lite 500件の組み立て 0.74秒 + その他）
--   3秒では毎回ではないが頻繁に落ちる。実測で 8案件中 2〜4案件が失敗していた。
--
--   関数の先頭に PERFORM set_config('statement_timeout','30000',true) が書かれていたが、
--   statement_timeout のタイマーは文の開始時に決まるため実行中の文には効かない。
--   ALTER FUNCTION ... SET statement_timeout も同じ理由で効かない。
--   ロール設定を変えるしかない。
--
-- 影響:
--   anon の全クエリが最大15秒まで待てるようになる。速くなるわけではなく、
--   これまで3秒で打ち切られていた重いクエリが完走するようになる。
--   遅いクエリが接続を掴む時間は延びるので、遅いRPCが増えたら見直すこと。
--
-- 戻す場合:
--   ALTER ROLE anon SET statement_timeout = '3s';
--
-- 変更後は PostgREST が設定を読み直すよう通知が要る（下の NOTIFY）。

ALTER ROLE anon SET statement_timeout = '15s';

NOTIFY pgrst, 'reload config';
