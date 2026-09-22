-- llm_shadow に「どのファイルを解析した結果か」を記録する（2026-09-22）
--
-- 実害:
--   常駐ワーカーは raw_profile._llm_checked_at が無いものを拾う。同じ人材が
--   取引先から再送されると inbound-email が raw_profile を差し替え、印が消えて
--   再入する（これ自体は設計どおり）。
--   ところが経歴書は **同じファイル** なので、一番重い添付解析（Haiku・1〜3分）を
--   毎回やり直していた。ログ実測（5,093サイクル）:
--
--     添付解析 2,974回 のうち 1,236回(41.6%) が「同じ人材の2回目以降」
--     うち 602回 は前回と1文字も違わない結果（proj数・cov・est/gotが完全一致）
--
--   実例 H.K: 27回処理され、毎回 proj=18 / est/got=18/18、cov だけ 0.68⇔0.71 と
--   LLM のゆらぎで揺れていた。得た情報はゼロで、日次上限の枠だけを消費していた。
--
-- なぜ URL をキーにしてよいか:
--   Storage のファイル名は `stableResumeName()` が **内容の SHA-256 先頭20桁** を
--   埋め込んでいる（inbound-email/index.ts）。同じ URL なら中身はバイト単位で同じ。
--   中身が1バイトでも違えば別パスになるので、古い結果を誤って使い回すことはない。
--
-- extractor_version:
--   抽出器を直したら結果は変わるべきなので、URL が同じでもキャッシュを捨てたい。
--   ワーカー側の定数を書き込んでおき、一致しなければ解析し直す。

alter table llm_shadow add column if not exists source_url text;
alter table llm_shadow add column if not exists extractor_version text;

comment on column llm_shadow.source_url is
  '解析した経歴書の URL。ファイル名に内容ハッシュが入るので「同じURL＝同じ中身」。再解析を省く判定に使う';
comment on column llm_shadow.extractor_version is
  '解析時の抽出器バージョン。上げると URL が同じでもキャッシュを使わず解析し直す';

select 'llm_shadow.source_url / extractor_version added' as ok;
