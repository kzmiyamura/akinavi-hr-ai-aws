-- add_skill.mjs で手で足され、git のどこにも残っていなかった skill_master の行。
-- scripts/gen_skill_master_migration.mjs が本番の控えから生成（2026-09-27）。
--
-- なぜ要るか:
--   これらは**本番にしか存在しなかった**。Supabase を Free に落とすと
--   自動バックアップが無くなるので、壊したときに戻す先が無い。
--   git に入れておけば、控えが無くてもここから戻せる。
--
-- 実際に効いている行である（生成時点の一致回数）:
--   FortiGate … 2585回
--   Palo Alto Networks … 1618回
--   CheckPoint … 312回
--   Zscaler … 525回
--   Meraki … 744回
--   社内SE … 24030回
--   英語 … 20401回
--   英検2級 … 1510回
--   ヘルプデスク … 27137回
--   簿記 … 2338回
--   テクニカルサポート … 14179回
--   NetBackup … 644回
--   財務会計 … 12156回
--   YAMAHAルーター … 393回
--   WatchGuard … 5回
--   Cisco … 6914回
--   NetScaler … 85回
--   英検1級 … 219回
--   アライドテレシス … 429回
--   SonicWall … 111回
--   mcframe … 109回
--   F5 BIG-IP … 1689回
--   Juniper … 1329回
--   UAT … 3383回
--   勘定系 … 3058回
--   海外業務 … 3409回
--   金融知識 … 27713回
--
-- ⚠ 既にある行には触らない。
--   skill_master は**既存行を編集する**のが鉄則で、同じ意味の行を新しく作ると
--   正式名を奪って一致が壊れる（実績: 該当者が28人→1人）。
--   name に一意制約があるので ON CONFLICT DO NOTHING で素通りさせる。
--   match_count / last_matched_at は実行時に積み上がる値なので入れない。

INSERT INTO skill_master (id, name, category, aliases, source, is_generic) VALUES
  ('0b50e2d4-221c-4729-94f7-e06f0159eff4', 'FortiGate', 'infrastructures', '["fortigate","Fortinet","FortiNet","フォーティゲート"]'::jsonb, 'seed', false),
  ('18dc1ae0-2a6b-473d-b23d-af30035d6e08', 'Palo Alto Networks', 'infrastructures', '["PaloAlto","Palo Alto","PAN-OS","paloalto"]'::jsonb, 'seed', false),
  ('2446b83a-1d8b-4f76-81d5-50012fbea330', 'CheckPoint', 'infrastructures', '["Check Point","checkpoint","チェックポイント"]'::jsonb, 'seed', false),
  ('2cbe7ed5-fcb4-4416-9b05-c68cf2c29c8f', 'Zscaler', 'infrastructures', '["zscaler","ZScaler"]'::jsonb, 'seed', false),
  ('2e4807d4-4ff2-49ba-808a-ba1c163ecf5d', 'Meraki', 'infrastructures', '["Cisco Meraki","cisco meraki","meraki"]'::jsonb, 'seed', false),
  ('3087ad14-394e-4946-9db5-efbc8e4d8d9f', '社内SE', 'methodologies', '["社内システム","情報システム部","社内IT"]'::jsonb, 'seed', false),
  ('3b921da5-4850-4be0-b79a-69e64577ac78', '英語', 'others', '["英語力","English","英会話","英文メール","英語対応","英語コミュニケーション","英語スキル"]'::jsonb, 'seed', false),
  ('4d90c314-3334-4a29-966c-c0be4102f748', '英検2級', 'certifications', '["英語検定2級","eiken 2","実用英語技能検定2級","英検2","英検二級","英語技能検定2級"]'::jsonb, 'seed', false),
  ('4e583928-822c-4519-9201-697cb353f77d', 'ヘルプデスク', 'methodologies', '["help desk","helpdesk","ヘルプデスク業務"]'::jsonb, 'seed', false),
  ('54700c4a-5eec-4147-8919-a9f1285c0ec4', '簿記', 'certifications', '["簿記検定","boki"]'::jsonb, 'seed', false),
  ('6a8c6b39-c07d-4955-b5f6-50207360720b', 'テクニカルサポート', 'methodologies', '["テクサポ","技術サポート","technical support"]'::jsonb, 'seed', false),
  ('723f7f0f-4976-41b4-9386-3a242a5a1f21', 'NetBackup', 'tools', '["Veritas NetBackup","netbackup"]'::jsonb, 'seed', false),
  ('73005994-709e-41e2-a430-87d1cded3043', '財務会計', 'others', '["財務","会計","financial accounting","財務・会計","財務/会計"]'::jsonb, 'seed', false),
  ('8aac99cb-ea75-48ff-bc3f-e362b72e5af7', 'YAMAHAルーター', 'infrastructures', '["YAMAHAルータ","YAMAHA ルーター","YAMAHA ルータ","ヤマハルーター","YAMAHA RTX"]'::jsonb, 'seed', false),
  ('974728d6-75c2-4a77-8a3f-ecc629f47717', 'WatchGuard', 'infrastructures', '["watchguard","ウォッチガード"]'::jsonb, 'seed', false),
  ('98f3321b-00e0-48c0-a31d-f744deb4868f', 'Cisco', 'infrastructures', '["シスコ","Cisco Systems","cisco"]'::jsonb, 'seed', false),
  ('a767bf12-8dcb-4dc9-af39-edc502e774d1', 'NetScaler', 'infrastructures', '["Citrix ADC","citrix adc","netscaler"]'::jsonb, 'seed', false),
  ('bbc0bb42-beab-4fec-93f8-cb42962759e1', '英検1級', 'certifications', '["英語検定1級","eiken 1","実用英語技能検定1級","英検1","英検一級","英語技能検定1級"]'::jsonb, 'seed', false),
  ('c0488857-086d-4d01-8456-725ee7eac0c1', 'アライドテレシス', 'infrastructures', '["Allied Telesis","AlliedTelesis","allied telesis"]'::jsonb, 'seed', false),
  ('c33221c9-fc09-4dd1-99c1-589205a7dbf3', 'SonicWall', 'infrastructures', '["sonic wall","sonicwall"]'::jsonb, 'seed', false),
  ('c9399a6f-b6fd-4d14-87b2-7f035faf45ac', 'mcframe', 'tools', '["mcFrame","MCFrame"]'::jsonb, 'seed', false),
  ('cab3b235-a37d-4850-99b0-fd7315af129f', 'F5 BIG-IP', 'infrastructures', '["F5","BIG-IP","big-ip","F5 Networks"]'::jsonb, 'seed', false),
  ('cadd84ff-c354-4cd6-a22f-ece6b70b1dc2', 'Juniper', 'infrastructures', '["Juniper Networks","JuniperNetworks","juniper"]'::jsonb, 'seed', false),
  ('d08f2ed4-ede1-46d3-a8e9-156ddfe0788e', 'UAT', 'methodologies', '["受入テスト","ユーザー受入テスト","User Acceptance Test"]'::jsonb, 'seed', false),
  ('d0c5272b-a3da-4929-a0c4-13a5d4131395', '勘定系', 'others', '["勘定系システム","コアバンキング","勘定系開発","core banking","銀行システム","銀行勘定","勘定"]'::jsonb, 'seed', false),
  ('d543af2d-daa3-43c8-95f4-674116ecda49', '海外業務', 'others', '["海外対応","国際業務","グローバル対応","海外拠点","海外店","英語業務","海外出張","海外取引","海外折衝","海外駐在","海外案件"]'::jsonb, 'seed', false),
  ('ebc38fbc-d09f-4080-a240-46e78b06e73e', '金融知識', 'others', '["金融","銀行業務","金融業界","ファイナンス","finance","金融系","銀行系"]'::jsonb, 'seed', false)
ON CONFLICT (name) DO NOTHING;

-- 別名で引く辞書（マテリアライズドビュー）を貼り直す。
-- これをしないと、行はあるのに一致判定に出てこない。
REFRESH MATERIALIZED VIEW skill_norm_map;
