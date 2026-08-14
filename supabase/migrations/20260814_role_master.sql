-- 役割（PM / PMO / エンジニア / ヘルプデスク …）の定義とその近さ。
--
-- 背景（2026-08-14）:
--   人材側は raw_profile.roles に主役割を持っている（inbound-email の scoreProseRoles、
--   スコア降順で先頭が主役割）が、**案件側に「求める役割」が無い**ため
--   採点にも順位付けにも一切使われていなかった。
--   その結果、PMO歴10年の人が実装案件の1位（95点）になっていた。
--
-- ここでは「ラベル → 系統」の対応だけを持つ。案件側の requiredRole は
--   AI解釈（raw_data.aiInterpretation.requiredRole）が入れる。
--
-- ⚠ 系統は多対多。**PMO は management と support の両方に属する**
--   （ユーザー指摘 2026-08-14: 「運用サポートはまさに PMO も含む」）。
--   1ラベル1系統にすると、ヘルプデスク案件の PMO を不当に落とす。

CREATE TABLE IF NOT EXISTS role_master (
  label  text NOT NULL,
  family text NOT NULL CHECK (family IN ('management', 'engineering', 'support')),
  PRIMARY KEY (label, family)
);

GRANT SELECT ON role_master TO anon, authenticated;

-- 再実行できるように入れ直す
DELETE FROM role_master;

INSERT INTO role_master (label, family) VALUES
  -- ── マネジメント・推進系 ──
  ('プロジェクトマネージャー', 'management'),
  ('PMO',                      'management'),
  ('プロジェクトリーダー',     'management'),
  ('スクラムマスター',         'management'),
  ('コンサルタント',           'management'),
  -- ── 実装系 ──
  ('システムエンジニア',       'engineering'),
  ('プログラマー',             'engineering'),
  ('テックリード',             'engineering'),
  ('アーキテクト',             'engineering'),
  ('インフラエンジニア',       'engineering'),
  ('フロントエンドエンジニア', 'engineering'),
  ('バックエンドエンジニア',   'engineering'),
  ('フルスタックエンジニア',   'engineering'),
  ('クラウドエンジニア',       'engineering'),
  ('データエンジニア',         'engineering'),
  ('MLエンジニア',             'engineering'),
  -- ── 運用サポート系 ──
  ('ヘルプデスク',             'support'),
  ('運用保守',                 'support'),
  ('テストエンジニア',         'support'),
  -- PMO は推進役として運用サポート案件にも効く（多重所属）
  ('PMO',                      'support'),
  -- テックリードは実装寄りだが推進も担う
  ('テックリード',             'management'),
  -- アーキテクトはコンサル的な立ち回りもする
  ('アーキテクト',             'management');

-- 役割どうしの近さ。0.0〜1.0。
-- **ゲートではない**（ユーザー指摘 2026-08-14「他と一緒でうまく点数付けしたらいい」）。
-- 系統違いでも 0.2 は残す＝他の項目（スキル・単価・勤務地）と同じ重み付き加点として扱う。
CREATE OR REPLACE FUNCTION role_affinity(p_required text, p_candidate text)
RETURNS numeric
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    -- どちらか不明なら中立（他項目の「記載なし」と同じ扱い）
    WHEN p_required IS NULL OR p_candidate IS NULL
      OR btrim(p_required) = '' OR btrim(p_candidate) = ''      THEN 0.5
    WHEN p_required = p_candidate                                THEN 1.0
    WHEN EXISTS (
      SELECT 1 FROM role_master r
      JOIN role_master c ON c.family = r.family
      WHERE r.label = p_required AND c.label = p_candidate
    )                                                            THEN 0.7
    ELSE 0.2
  END;
$$;

GRANT EXECUTE ON FUNCTION role_affinity(text, text) TO anon, authenticated;
