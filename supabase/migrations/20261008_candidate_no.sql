-- 人材に「人が読める通し番号」を振る ①列と連番（2026-10-08）
--
-- ■ なぜ
--   引けるキーが `id`（uuid）しか無く、口頭でも検索でも使えない。
--   「リクラシの TI さん」のように会社名＋イニシャルで探すしかなく、
--   同名が多い（prod 実測で同名10件超の氏名が52種・最大35件）ので特定できない。
--   `AK-000123` のような短い番号があれば、メモにも口頭にも載る。
--
-- ■ 列で持つ（別表にしない）。bookmarked と同じ理由
--   ・人材は保持日数で行ごと消えるので、列なら一緒に消える（外部キー不要）
--   ・同一会社からの再送は既存行の UPDATE なので、**番号は維持される**
--     （`inbound-email` は created_at を now() に書き換えて7日カウントを延ばす。
--       行は生き続けるため番号も変わらない）
--
-- ■ 番号が変わる場合がある。これは仕様として受け入れる
--   7日の保持を過ぎて行が消えた後に再送されると、新しい行＝新しい番号になる。
--   実測（控え・2026-09-01 以降の 8,395人）: 「7日の保持を過ぎた再登録」171組。
--   つまり **2% 程度は番号が変わる**。恒久的な人物IDにするには保持期間を越えて
--   生き残る人物台帳が必要で、それは「入口だけあって出口が無い表」になるため作らない。
--
-- ■ 連番は prod / demo で共有する
--   data_env ごとに分けると、同じ番号が2人に当たって口頭で事故る。
--
-- ■ このファイルだけでは画面に出ない。**単体で当てても無害**
--   ビューと関数は 20261008_candidate_no_view.sql に分けてある。
--   そちらを当てるまで誰もこの列を読まない。順番は「このファイル → view のファイル」。
--   2つに分けた理由: view 側はビューと3関数を差し替えるので、
--   失敗したときにどちらで転んだのかが分からないと直せない（2026-10-08 に一度失敗した）。

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS candidate_no bigint;

CREATE SEQUENCE IF NOT EXISTS candidates_candidate_no_seq AS bigint;

-- 既存行に古い順で振る。
-- ⚠ `UPDATE ... SET candidate_no = nextval(...)` は行の処理順を保証しないので、
--   「登録が古い人ほど小さい番号」にならない。row_number で順序を決めてから当てる。
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
    FROM candidates
   WHERE candidate_no IS NULL
)
UPDATE candidates c
   SET candidate_no = o.rn
  FROM ordered o
 WHERE c.id = o.id;

SELECT setval('candidates_candidate_no_seq',
              GREATEST((SELECT COALESCE(MAX(candidate_no), 0) FROM candidates), 1));

ALTER TABLE candidates
  ALTER COLUMN candidate_no SET DEFAULT nextval('candidates_candidate_no_seq');
ALTER SEQUENCE candidates_candidate_no_seq OWNED BY candidates.candidate_no;
ALTER TABLE candidates
  ALTER COLUMN candidate_no SET NOT NULL;

-- 番号で引くための索引。一意にしておく（口頭で使う番号が重複したら意味が無い）
CREATE UNIQUE INDEX IF NOT EXISTS candidates_candidate_no_unique
  ON candidates (candidate_no);

COMMENT ON COLUMN candidates.candidate_no IS
  '人が読める通し番号。画面では AK-000123 の形で出す。再送の UPDATE では維持されるが、
   保持期間を過ぎて消えた後の再登録では新しい番号になる（実測で約2%）';
