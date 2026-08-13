-- skill_master を更新したあとに正規化辞書を貼り直す。
-- skill_norm_map はマテリアライズドビューなので、トリガが効いていない場合は手動で必要。
REFRESH MATERIALIZED VIEW skill_norm_map;

SELECT count(*) AS 辞書件数,
       count(*) FILTER (WHERE canon = 'entraid') AS entraid関連
  FROM skill_norm_map;
