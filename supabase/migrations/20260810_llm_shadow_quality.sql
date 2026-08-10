-- llm_shadow に品質メトリクスの列を追加（2026-08-10）
--
-- Sonnet 昇格をやめ Haiku 単独運用にしたのに伴い、判定を2つに分けた:
--   status='needs_review' … 結果が使えない（案件ゼロ・日付が壊れている）だけに付ける
--   quality               … 捕捉率・案件数差分などの「程度問題」を数値のまま保持する
--
-- 以前は程度問題も needs_review に含めていたため実測65%が要確認となり、
-- フラグとして機能していなかった。数値で残せば抽出器の改善materialにもなる。
--
-- 想定する中身:
--   {"coverage":0.72,"gridToks":25,"est":8,"got":7,"shortfall":1,
--    "emptyTechsRatio":0.14,"monthLabelAgree":0.86,"selfConfidence":"high"}
alter table llm_shadow add column if not exists quality jsonb;

comment on column llm_shadow.quality is
  '抽出品質の程度を表す数値。二値フラグにせず保持し、閾値調整・抽出器改善の材料にする';

select 'llm_shadow.quality added' as ok;
