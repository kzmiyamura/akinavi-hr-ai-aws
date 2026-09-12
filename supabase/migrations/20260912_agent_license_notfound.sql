-- agent_companies.license_status に 'notfound'（照合できず）を追加する。
--
-- これまで verify-agent-license は、厚労省「人材サービス総合サイト」で検索が0件
-- だった会社に 'none'（免許なし）を書いていた。0件は「免許が無い」ではなく
-- 「この社名では引けなかった」であり、別の事実。
--
-- 実害（2026-09-12 実測）:
--   ・2026-06-06〜07-07 は検索が一度も成立せず、66社が一律 'none' で固定された
--     （検索キーが半角のままで、サイト側の全角表記に当たらなかったのが主因。
--       "GFD" は0件・"ＧＦＤ" は 派14-301189）
--   ・fetch_candidates_for_project の p_require_haken は
--     license_status IN ('haken','both') で絞るため、該当社の人材が
--     派遣案件のマッチングから丸ごと落ちていた（prod 752人 / 38社）
--   ・画面には赤字で「免許なし」と出ており、営業の取引可否判断に直接効いていた
--
-- 'notfound' は絞り込み上は 'none' と同じ（派遣案件には出さない）。変えるのは
-- 「言い切るかどうか」であって、安全側の扱いは変えない。

ALTER TABLE agent_companies DROP CONSTRAINT IF EXISTS agent_companies_license_status_check;

ALTER TABLE agent_companies
  ADD CONSTRAINT agent_companies_license_status_check
  CHECK (license_status IN ('unknown','haken','shokai','both','notfound','none'));

COMMENT ON COLUMN agent_companies.license_status IS
  'unknown=会社名が取れず未照合 / haken / shokai / both / notfound=厚労省サイトで引けなかった（免許が無いとは限らない） / none=免許なしと人が確認した';
