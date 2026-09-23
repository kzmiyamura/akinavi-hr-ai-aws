-- parse_rate_wan が全角数字で例外を投げ、マッチングのランキングが落ちていた（2026-09-23）
--
-- ■ 何が起きていたか
--   マッチング画面の候補者ランキング（fetch_candidates_for_project）が
--   **prod の全呼び出しで例外**になっていた:
--
--     ERROR: 22P02: invalid input syntax for type numeric: "６０"
--     CONTEXT: SQL function "parse_rate_wan"
--
--   原因は PostgreSQL の `\d`。**`\d` は Unicode の数字に一致するので全角 ０-９ も拾う**が、
--   `::numeric` は ASCII 数字しか受け付けない。
--   希望単価が「６０万円(140h-180h)～応相談」の人材が1人でも候補集合に入ると、
--   `pre` CTE は全行について parse_rate_wan を評価するため、クエリ全体が落ちる。
--
--   該当人材: 4db91958-be64-441e-a722-f793685d4906（2026-09-16 登録）
--   **つまり 9/16 以降、マッチングのランキングは動いていなかった。**
--
-- ■ 同型の取りこぼし
--   2026-09-21 に同じ事故を parse_rate_man と parse_available_from で直しており、
--   どちらも `translate` で全角を潰してから `[0-9]` で拾う形にしてある。
--   **parse_rate_wan だけ直し忘れていた。**
--   全関数を洗い直した結果、`\d` を使ったまま translate が無いのはこれだけ。
--
-- ■ 直しかた
--   ① 先に全角数字・全角ピリオドを ASCII に寄せる（translate）
--   ② 正規表現は `\d` ではなく **`[0-9]` 明示**にする（将来また Unicode 数字を拾わない）
--   意味（MAX を採る・500万上限・万なしは素の数値）は変えない。
--   ここで挙動まで変えると、落ちていた原因と混ざって検証できなくなる。
--
-- ■ 置き換えの安全性
--   式インデックス・ビューからの参照は無く、呼んでいるのは
--   fetch_candidates_for_project のみ（確認済み）。CREATE OR REPLACE で差し替わる。

CREATE OR REPLACE FUNCTION public.parse_rate_wan(p_text text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH t AS (
    -- 全角数字と全角ピリオドを ASCII に寄せてから読む。
    -- これをしないと `\d`/Unicode 数字が拾えてしまい ::numeric で 22P02 になる
    SELECT translate(COALESCE(p_text, ''), '０１２３４５６７８９．', '0123456789.') AS s
  )
  SELECT COALESCE(
    (SELECT MAX((m[1])::numeric)
       FROM t, regexp_matches(t.s, '([0-9]+(?:\.[0-9]+)?)\s*万', 'g') m
      WHERE (m[1])::numeric > 0 AND (m[1])::numeric <= 500),
    -- 「万」が付かない純粋な数値（desired_rate 列の値など）はそのまま採る
    (SELECT CASE WHEN t.s ~ '^\s*[0-9]+(\.[0-9]+)?\s*$'
                 THEN trim(t.s)::numeric END
       FROM t)
  )
$function$;

-- ── 検証 ────────────────────────────────────────────────────────────────
-- 落ちていた実データと、境界をその場で確かめる
select
  parse_rate_wan('６０万円(140h-180h)～応相談') as "全角60万→60",
  parse_rate_wan('60万円')                      as "半角60万→60",
  parse_rate_wan('55～60万')                    as "範囲は上限→60",
  parse_rate_wan('７０')                        as "全角の素の数値→70",
  parse_rate_wan('600万')                       as "500万超は不採用→null",
  parse_rate_wan('応相談')                      as "数値なし→null",
  parse_rate_wan('')                            as "空→null",
  parse_rate_wan(null)                          as "null→null";
