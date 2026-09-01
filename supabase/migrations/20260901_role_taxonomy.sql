-- 役割の近さを「系統3分類」から「作用対象 × 権限」の2軸に置き換える。
-- 定義と根拠は docs/ROLE_DEFINITION.md が正。
--
-- 背景（2026-09-01 ユーザー指摘）:
--   「pmoはプロジェクトの事務所扱いにして。pmとは雲泥の差があること」
--   「しっかり役割定義して。適当なカテゴリ分けしないで」
--   旧 role_master は PM と PMO を同じ 'management' に入れていたため 0.7（同系統）だった。
--   日本PMO協会の定義では、PM は「プロジェクト」に、PMO は「プロジェクトマネジメント」に
--   働きかける。対象が違う。さらに PM は決裁権を持ち PMO は持たない。両軸とも最遠。
--
-- ⚠ 旧 role_master は消さない。role_affinity を CREATE OR REPLACE で差し替えるだけなので
--   この移行はダウンタイムゼロで、旧定義に戻すのも旧 CREATE OR REPLACE を流すだけで済む。
--   本番で検証したあと、別マイグレーションで role_master を落とす。

-- ── 軸1: 作用対象、軸2: 権限 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_axis (
  label     text PRIMARY KEY,
  object    text NOT NULL CHECK (object IN ('事業','成果','仕組み','製品','サービス')),
  authority int  NOT NULL CHECK (authority BETWEEN 1 AND 4),
  note      text
);
COMMENT ON TABLE role_axis IS
  '役割の定義軸。object=何に働きかけるか / authority=4決裁 3統率 2実行 1支援。docs/ROLE_DEFINITION.md が正';

GRANT SELECT ON role_axis TO anon, authenticated;

DELETE FROM role_axis;
INSERT INTO role_axis (label, object, authority, note) VALUES
  -- 成果（このプロジェクトのQCD）に働きかける
  ('プロジェクトマネージャー', '成果',   4, 'IPA PM試験 対象者像: 品質・コスト・納期に責任を持つ'),
  ('プロジェクトリーダー',     '成果',   3, '指示権はあるが予算・契約の決裁権を持たない'),
  -- 仕組み（マネジメントの型）に働きかける
  ('PMO',                      '仕組み', 1, '日本PMO協会: PMは「プロジェクト」に、PMOは「プロジェクトマネジメント」に活動する。成否の責任を負わない'),
  ('スクラムマスター',         '仕組み', 2, 'Scrum Guide 2020: チームの有効性に責任を持つが指示権はない'),
  -- 事業（顧客の経営・業務）に働きかける
  ('コンサルタント',           '事業',   3, 'ITSS コンサルタント職種。実行の責任は顧客側'),
  -- 製品（作るシステムそのもの）に働きかける
  ('アーキテクト',             '製品',   3, 'IPA SA試験 対象者像: 構造を設計し開発を主導する'),
  ('テックリード',             '製品',   3, '実装しながら技術判断を行う'),
  ('システムエンジニア',       '製品',   2, '要件定義〜設計〜テストの汎用ラベル'),
  ('プログラマー',             '製品',   2, '設計に基づき実装する'),
  ('フロントエンドエンジニア', '製品',   2, NULL),
  ('バックエンドエンジニア',   '製品',   2, 'インタフェースとデータ構造を設計し実装する'),
  ('フルスタックエンジニア',   '製品',   2, NULL),
  ('インフラエンジニア',       '製品',   2, NULL),
  ('クラウドエンジニア',       '製品',   2, NULL),
  ('データエンジニア',         '製品',   2, NULL),
  ('MLエンジニア',             '製品',   2, NULL),
  ('テストエンジニア',         '製品',   2, '品質の検証に責任を持つ'),
  -- サービス（稼働中のサービス）に働きかける
  ('運用保守',                 'サービス', 2, 'IPA SM試験の実務層。監視・障害対応・定常運用'),
  ('ヘルプデスク',             'サービス', 1, 'ITSS カスタマーサービス。一次受けして解決または取り次ぐ');

-- ── 作用対象どうしの距離 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_object_distance (
  a        text NOT NULL,
  b        text NOT NULL,
  distance int  NOT NULL CHECK (distance BETWEEN 0 AND 2),
  PRIMARY KEY (a, b)
);
COMMENT ON TABLE role_object_distance IS
  '作用対象どうしの近さ。0=同一 1=隣接 2=遠い。根拠は docs/ROLE_DEFINITION.md 3章';

GRANT SELECT ON role_object_distance TO anon, authenticated;

DELETE FROM role_object_distance;
-- 距離1の根拠:
--   事業↔成果    コンサルの提案がそのままプロジェクトになる
--   事業↔製品    アーキテクトは事業要件を構造に落とす
--   成果↔仕組み  日本PMO協会の定義そのもの（PMOはPMの活動を対象にする）
--   成果↔製品    PLは成果物を通じて成果を出す
--   製品↔サービス 作ったものが運用に渡る
--   仕組み↔サービス どちらも「回し続ける」支援業務
INSERT INTO role_object_distance (a, b, distance)
SELECT a, b, d FROM (VALUES
  ('事業','事業',0),   ('事業','成果',1),   ('事業','仕組み',2), ('事業','製品',1),   ('事業','サービス',2),
  ('成果','成果',0),   ('成果','仕組み',1), ('成果','製品',1),   ('成果','サービス',2),
  ('仕組み','仕組み',0),('仕組み','製品',2), ('仕組み','サービス',1),
  ('製品','製品',0),   ('製品','サービス',1),
  ('サービス','サービス',0)
) v(a,b,d)
UNION
SELECT b, a, d FROM (VALUES
  ('事業','事業',0),   ('事業','成果',1),   ('事業','仕組み',2), ('事業','製品',1),   ('事業','サービス',2),
  ('成果','成果',0),   ('成果','仕組み',1), ('成果','製品',1),   ('成果','サービス',2),
  ('仕組み','仕組み',0),('仕組み','製品',2), ('仕組み','サービス',1),
  ('製品','製品',0),   ('製品','サービス',1),
  ('サービス','サービス',0)
) v(a,b,d);

-- ── 近さの算出 ──────────────────────────────────────────────────────────────
-- affinity = clamp(対象係数 × 権限係数, 0.2, 0.9)
--   対象係数 = 距離0→1.0 / 1→0.6 / 2→0.35
--   権限係数 = 差0→1.0 / 1→0.75 / 2→0.5 / 3→0.3
-- 同一ラベル = 1.0、どちらか不明 = 0.5（ゲートではない。2026-08-14 ユーザー判断で下限0.2は据え置き）
--
-- ⚠ シグネチャは変えない。fetch_candidates_for_project が呼んでいる（唯一のDB内消費者）。
-- ⚠ match-batch/index.ts の roleAffinity() を必ず同じ内容に保つこと。
CREATE OR REPLACE FUNCTION role_affinity(p_required text, p_candidate text)
RETURNS numeric
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_required IS NULL OR p_candidate IS NULL
      OR btrim(p_required) = '' OR btrim(p_candidate) = ''      THEN 0.5
    WHEN p_required = p_candidate                                THEN 1.0
    ELSE COALESCE((
      SELECT GREATEST(0.2, LEAST(0.9,
               (CASE d.distance WHEN 0 THEN 1.0 WHEN 1 THEN 0.6 ELSE 0.35 END)
             * (CASE abs(r.authority - c.authority)
                  WHEN 0 THEN 1.0 WHEN 1 THEN 0.75 WHEN 2 THEN 0.5 ELSE 0.3 END)))
      FROM role_axis r
      JOIN role_axis c ON c.label = p_candidate
      JOIN role_object_distance d ON d.a = r.object AND d.b = c.object
      WHERE r.label = p_required
    ), 0.5)   -- 一覧に無いラベルは中立（旧実装は 0.2 に落としていた）
  END;
$$;

GRANT EXECUTE ON FUNCTION role_affinity(text, text) TO anon, authenticated;
