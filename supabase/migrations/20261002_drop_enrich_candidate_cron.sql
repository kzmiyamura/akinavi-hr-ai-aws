-- ============================================================================
-- enrich-candidate の定期実行を外す（2026-10-02）
--
-- enrich-candidate は Google Drive 上の経歴書を **Gemini で解析**して人材を
-- 更新するバッチだった。外部AIを全廃する方針（claude -p に一本化）に伴い
-- 関数ごと削除したので、呼び出し元の cron も外す。
--
-- 同じ仕事はローカルの常駐ワーカー（pm2: akinavi-shadow）が既に担っている:
--   Box取込キューを30秒間隔で監視 → ダウンロード → textract → 再解析 →
--   claude -p で校正。2026-08-08 から全自動。
--
-- ⚠ これを適用する前に Edge Function 側の削除（`supabase functions delete
--   enrich-candidate`）まで終わっているか確認すること。cron だけ外して関数が
--   残っていても害は無いが、逆（関数を消して cron が残る）は毎日エラーになる。
-- ============================================================================

SELECT cron.unschedule('enrich-candidate-daily')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enrich-candidate-daily');
