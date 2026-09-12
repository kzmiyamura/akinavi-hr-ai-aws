-- agent_companies の免許判定の修復（2026-09-12）
--
-- 直した2つの取り違え:
--   ① 検索キーが半角のままで、サイト側の全角表記（「株式会社ＧＦＤ」）に当たっていなかった
--   ② 引けなかった＝免許なし(none) と記録していた。正しくは照合できず(notfound)
--   ③ 結果ページの先頭の番号を社名照合なしで採っていた（他社の番号が付いていた）
--
-- 再照合 268 社: 免許あり 122 社 / 照合できず 146 社

begin;

-- ① 免許が確認できた会社（社名が完全一致した行の番号だけを採用）
update agent_companies set license_status = 'haken', haken_number = '派13-318764', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318764%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'autumn-co.jp';  -- 株式会社オータム
update agent_companies set license_status = 'haken', haken_number = '派13-318064', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318064%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'kaizentech.co.jp';  -- 株式会社Kaizen Tech Agent ←「株式会社Ｋａｉｚｅｎ　Ｔｅｃｈ　Ａｇｅｎｔ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-317147', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317147%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'visionary-jp.com';  -- 株式会社VISIONARY JAPAN ←「株式会社ＶＩＳＩＯＮＡＲＹ　ＪＡＰＡＮ」で一致
update agent_companies set license_status = 'haken', haken_number = '派27-304724', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-304724%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'phoenix-tecs.com';  -- 株式会社Phoenixテクノロジーズ ←「株式会社Ｐｈｏｅｎｉｘテクノロジーズ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-318536', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318536%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'jqit.co.jp';  -- 株式会社JQIT ←「株式会社ＪＱＩＴ」で一致
update agent_companies set license_status = 'haken', haken_number = '派28-302228', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE28-302228%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'kcs.co.jp';  -- 株式会社さくらケーシーエス
update agent_companies set license_status = 'haken', haken_number = '派13-305929', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-305929%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'l-owcal.com';  -- 株式会社LOWCAL ←「株式会社ＬＯＷＣＡＬ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-317103', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317103%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'r-k-sol.com';  -- 株式会社RKソリューション ←「株式会社ＲＫソリューション」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-309515', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309515%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'm-it.co.jp';  -- 株式会社MIT ←「株式会社ＭＩＴ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-312688', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-312688%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'kico.co.jp';  -- ㈱KICOシステムズ ←「株式会社ＫＩＣＯシステムズ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-313843', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-313843%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'figeo.co.jp';  -- 株式会社フィジオ
update agent_companies set license_status = 'haken', haken_number = '派14-301189', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE14-301189%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'gf-design.jp';  -- 株式会社GFD ←「株式会社ＧＦＤ」で一致
update agent_companies set license_status = 'haken', haken_number = '派38-300093', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE38-300093%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'forward-career.jp';  -- 株式会社フォワード ←「フォワード」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-318436', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318436%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cho-tatsu.com';  -- 株式会社リクラシ
update agent_companies set license_status = 'haken', haken_number = '派13-318694', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318694%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'saitekiinc.com';  -- 株式会社Saiteki ←「株式会社Ｓａｉｔｅｋｉ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-308811', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-308811%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'comture.com';  -- エディフィストラーニング株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-309988', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309988%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'keyware.co.jp';  -- キーウェアソリューションズ株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-314658', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314658%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ansurs.co.jp';  -- 株式会社アンスール
update agent_companies set license_status = 'haken', haken_number = '派13-308780', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-308780%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cs-echo.co.jp';  -- CSエコー株式会社 ←「ＣＳエコー株式会社」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-309482', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309482%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'srabhc.sra.co.jp';  -- 株式会社SRA ←「株式会社ＳＲＡ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-307586', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-307586%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'smhc.co.jp';  -- SMHC株式会社 ←「ＳＭＨＣ株式会社」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-309876', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309876%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cvcf.co.jp';  -- CVCF株式会社 ←「ＣＶＣＦ株式会社」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-305495', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-305495%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'fcn-co.jp';  -- 株式会社FCN ←「株式会社ＦＣＮ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-310898', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-310898%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'medialink-ml.co.jp';  -- メディアリンク株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-317591', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317591%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'kir-gr.com';  -- 株式会社Kir ←「株式会社Ｋｉｒ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-305223', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-305223%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ctc-g.co.jp';  -- ＣＴＣシステムマネジメント株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-303936', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-303936%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'dream-v.co.jp';  -- ドリームビジョン株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-313859', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-313859%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'colla-tech.co.jp';  -- コラボテクノ株式会社
update agent_companies set license_status = 'haken', haken_number = '派27-301805', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-301805%2C3+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cal.co.jp';  -- キャル株式会社
update agent_companies set license_status = 'haken', haken_number = '派12-300779', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE12-300779%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'intelligible.ne.jp';  -- 株式会社インテリジブル
update agent_companies set license_status = 'haken', haken_number = '派27-302394', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-302394%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'quantex.co.jp';  -- 株式会社クオンテックス
update agent_companies set license_status = 'haken', haken_number = '派13-312321', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-312321%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'andtec.co.jp';  -- 株式会社アンドテック
update agent_companies set license_status = 'haken', haken_number = '派13-315174', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315174%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'h-basis.co.jp';  -- 株式会社ヘルスベイシス
update agent_companies set license_status = 'haken', haken_number = '派13-309998', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309998%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'brightstar.co.jp';  -- 株式会社ブライトスター
update agent_companies set license_status = 'haken', haken_number = '派13-313920', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-313920%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'alterbo.jp';  -- オルターボ株式会社
update agent_companies set license_status = 'haken', haken_number = '派27-304635', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-304635%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'route-zero.com';  -- 株式会社ルートゼロ
update agent_companies set license_status = 'haken', haken_number = '派13-316258', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316258%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'wedo-faust.com';  -- ウィードファウスト株式会社
update agent_companies set license_status = 'haken', haken_number = '派23-030053', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE23-030053%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'suntrust-stc.co.jp';  -- 株式会社エスティーシー ←「エスティーシー」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-318729', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318729%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'kad-japan.com';  -- 株式会社KAD ←「株式会社ＫＡＤ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-307187', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-307187%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sys-tc.co.jp';  -- 株式会社シスコム・テクノロジー
update agent_companies set license_status = 'haken', haken_number = '派13-314842', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314842%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ganasys.com';  -- ガナシス株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-311510', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-311510%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 's-eo.jp';  -- 株式会社SEO ←「株式会社ＳＥＯ」で一致
update agent_companies set license_status = 'haken', haken_number = '派23-301690', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE23-301690%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'pacific-sys.jp';  -- 株式会社パシフィックシステム
update agent_companies set license_status = 'haken', haken_number = '派13-317787', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317787%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ftec.ltd';  -- フリーテクノロジー株式会社
update agent_companies set license_status = 'haken', haken_number = '派08-300551', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE08-300551%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'macrosystem.co.jp';  -- 株式会社マクロシステム
update agent_companies set license_status = 'haken', haken_number = '派13-316814', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316814%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'wasabi-web.com';  -- 株式会社わさび
update agent_companies set license_status = 'haken', haken_number = '派13-317366', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317366%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'technication.co.jp';  -- 株式会社テクニケーションシード
update agent_companies set license_status = 'haken', haken_number = '派13-308959', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-308959%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'techtree.co.jp';  -- 株式会社テックツリー
update agent_companies set license_status = 'haken', haken_number = '派13-070203', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-070203%2C0+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'foster-net.co.jp';  -- 株式会社フォスターネット
update agent_companies set license_status = 'haken', haken_number = '派13-306435', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-306435%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'asp-e.com';  -- 株式会社エイ・エス・ピー
update agent_companies set license_status = 'haken', haken_number = '派13-307385', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-307385%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sakura-is.co.jp';  -- さくら情報システム株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-305475', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-305475%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'solidseed.co.jp';  -- ソリッドシード株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-312005', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-312005%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'eyebrains.co.jp';  -- アイブレインズ株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-316686', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316686%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'miraie-group.jp';  -- 株式会社Miraie ←「株式会社Ｍｉｒａｉｅ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-301050', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-301050%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'i-inter.co.jp';  -- 株式会社アイ・インターナショナル
update agent_companies set license_status = 'haken', haken_number = '派13-309930', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309930%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'jp.nssol.nipponsteel.com';  -- 日鉄ソリューションズ株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-315453', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315453%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'acrch.co.jp';  -- 株式会社アクロリーチ
update agent_companies set license_status = 'haken', haken_number = '派14-301261', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE14-301261%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'eee333.co.jp';  -- イースリー株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-310449', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-310449%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'it-lab.co.jp';  -- 株式会社アイティ総研
update agent_companies set license_status = 'haken', haken_number = '派13-315170', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315170%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'itether.co.jp';  -- アイテザー株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-308926', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-308926%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sanei-system.co.jp';  -- 株式会社三鋭システム
update agent_companies set license_status = 'haken', haken_number = '派13-315074', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315074%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'infinius.co.jp';  -- インフィニアス株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-316375', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316375%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'thinksource.co.jp';  -- 株式会社思源ソフト
update agent_companies set license_status = 'haken', haken_number = '派14-301208', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE14-301208%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'trinitas-yokohama.jp';  -- 株式会社トリニタス
update agent_companies set license_status = 'haken', haken_number = '派13-316074', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316074%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'caads.co.jp';  -- カーズ株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-307652', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-307652%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'lightware.co.jp';  -- 株式会社ライトウェア
update agent_companies set license_status = 'haken', haken_number = '派27-304571', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-304571%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'e-deftribe.com';  -- 株式会社Def tribe ←「株式会社Ｄｅｆ　ｔｒｉｂｅ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-312519', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-312519%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sales-highdimension.co.jp';  -- ハイディメンション株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-317309', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317309%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'info-biz-serv.com';  -- 株式会社アイビーエス
update agent_companies set license_status = 'haken', haken_number = '派13-314823', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314823%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'oneness-group.jp';  -- アルテミス株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-314819', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314819%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'beyond-works.co.jp';  -- 株式会社ビヨンドワークス
update agent_companies set license_status = 'haken', haken_number = '派13-306736', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-306736%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sense-si.com';  -- 株式会社センスインタナショナル
update agent_companies set license_status = 'haken', haken_number = '派13-315402', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315402%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'addlinks.jp';  -- 株式会社アドリンクス
update agent_companies set license_status = 'haken', haken_number = '派13-315465', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315465%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 't-e-system.com';  -- TES株式会社 ←「ＴＥＳ株式会社」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-318631', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318631%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = '1-r.co.jp';  -- イチアール株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-309366', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309366%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'wealive.co.jp';  -- ＷｅａＬｉｖｅ株式会社
update agent_companies set license_status = 'haken', haken_number = '派27-305613', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-305613%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'wellspec.co.jp';  -- 株式会社ウェルスペック
update agent_companies set license_status = 'haken', haken_number = '派13-316090', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316090%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sus-4.com';  -- 合同会社sus4 ←「合同会社ｓｕｓ４」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-309199', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309199%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'fik.jp';  -- フィック株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-310249', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-310249%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'soarest.co.jp';  -- 株式会社ソアレスト
update agent_companies set license_status = 'haken', haken_number = '派13-310013', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-310013%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sakya.jp';  -- 株式会社サクヤ
update agent_companies set license_status = 'haken', haken_number = '派23-301397', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE23-301397%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'stylesystem.co.jp';  -- 株式会社スタイルシステム
update agent_companies set license_status = 'haken', haken_number = '派13-309482', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309482%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'sra.co.jp';  -- 株式会社ＳＲＡ
update agent_companies set license_status = 'haken', haken_number = '派13-309914', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309914%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'skym.co.jp';  -- 株式会社ＳＫＹＭ
update agent_companies set license_status = 'haken', haken_number = '派13-315944', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315944%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'free-brain.co.jp';  -- 株式会社FREE BRAIN ←「株式会社ＦＲＥＥ　ＢＲＡＩＮ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-306425', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-306425%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'dcs.co.jp';  -- 三菱総研ＤＣＳ株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-311603', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-311603%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'coresoft-net.co.jp';  -- 株式会社コアソフト
update agent_companies set license_status = 'haken', haken_number = '派13-318184', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318184%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'framecareer.fairgrit.com';  -- 株式会社フレームキャリア
update agent_companies set license_status = 'haken', haken_number = '派13-315891', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315891%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'as-japan-web.co.jp';  -- 株式会社エーエスジャパン
update agent_companies set license_status = 'haken', haken_number = '派27-305405', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-305405%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'curation.co.jp';  -- 株式会社ヒューマンキュレーション
update agent_companies set license_status = 'haken', haken_number = '派13-314886', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314886%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'netvisionsystems.jp';  -- ネットビジョンシステムズ株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-318522', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318522%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'i-standard.jp';  -- 株式会社アイスタンダード
update agent_companies set license_status = 'haken', haken_number = '派13-307649', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-307649%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'wing-sol.co.jp';  -- ウイングソリューションズ株式会社
update agent_companies set license_status = 'haken', haken_number = '派27-302185', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-302185%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'hfws.co.jp';  -- 平成ファームワークス株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-307331', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-307331%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'belient.com';  -- 株式会社ベリアント
update agent_companies set license_status = 'haken', haken_number = '派14-300523', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE14-300523%2C0+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ical.jp';  -- 株式会社アイキャル
update agent_companies set license_status = 'haken', haken_number = '派13-303758', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-303758%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'techno-premier.co.jp';  -- テクノプレミア株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-317305', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317305%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'unite-neo.co.jp';  -- 株式会社UNITE NEO ←「株式会社ＵＮＩＴＥ　ＮＥＯ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-317374', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-317374%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'yakudoh.com';  -- 株式会社Yakudo ←「株式会社Ｙａｋｕｄｏ」で一致
update agent_companies set license_status = 'haken', haken_number = '派27-305643', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-305643%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'soft21.jp';  -- 株式会社オープンソフト
update agent_companies set license_status = 'haken', haken_number = '派13-306556', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-306556%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cw-consulting.co.jp';  -- 株式会社クラウドワークス
update agent_companies set license_status = 'haken', haken_number = '派13-315806', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315806%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'nap-japan.net';  -- 株式会社NAP ←「株式会社ＮＡＰ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-315510', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-315510%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'mx.zefact.co.jp';  -- 株式会社ゼファクト
update agent_companies set license_status = 'haken', haken_number = '派13-304964', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-304964%2C2+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ps-ss.co.jp';  -- 株式会社ピーエスアンドエス
update agent_companies set license_status = 'haken', haken_number = '派13-316985', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316985%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'comvace.com';  -- 株式会社comvace ←「株式会社ｃｏｍｖａｃｅ」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-313515', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-313515%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'kkk-c.com';  -- 株式会社スリーケーシー
update agent_companies set license_status = 'haken', haken_number = '派13-313794', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-313794%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'learningift.com';  -- ラーニンギフト株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-316491', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316491%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'unison-tech.co.jp';  -- 株式会社ユニゾン・テクノロジー
update agent_companies set license_status = 'haken', haken_number = '派13-316432', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316432%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'tobetech.jp';  -- toBE Tech株式会社 ←「ｔｏＢＥ　Ｔｅｃｈ株式会社」で一致
update agent_companies set license_status = 'haken', haken_number = '派13-309820', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309820%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cac.co.jp';  -- 株式会社シーエーシー
update agent_companies set license_status = 'haken', haken_number = '派13-309733', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-309733%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'jtpro.jp';  -- 株式会社日本技研プロフェッショナルアーキテクト
update agent_companies set license_status = 'haken', haken_number = '派13-314045', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314045%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'rivermee.com';  -- リバミー株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-314510', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314510%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cloud9-plus.com';  -- 株式会社クラウドナイン
update agent_companies set license_status = 'haken', haken_number = '派13-314240', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314240%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'seamaple.co.jp';  -- 株式会社シーメイプル
update agent_companies set license_status = 'haken', haken_number = '派13-318588', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318588%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'ase-info.com';  -- 株式会社エイ・エス・イー
update agent_companies set license_status = 'haken', haken_number = '派13-316693', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-316693%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'f-f-life.com';  -- 株式会社エフ・エフ・エル
update agent_companies set license_status = 'haken', haken_number = '派21-300404', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE21-300404%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'icom-sys.co.jp';  -- 株式会社アイコム
update agent_companies set license_status = 'haken', haken_number = '派27-302225', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE27-302225%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'wa-ki.jp';  -- 株式会社ワーキテクノ
update agent_companies set license_status = 'haken', haken_number = '派13-314249', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-314249%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'swingbytech.co.jp';  -- スイングバイテクノロジー株式会社
update agent_companies set license_status = 'haken', haken_number = '派13-313515', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-313515%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'cozy4.co.jp';  -- 株式会社スリーケーシー
update agent_companies set license_status = 'haken', haken_number = '派13-306807', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-306807%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'clover-sun.com';  -- 株式会社クローバー・サン
update agent_companies set license_status = 'haken', haken_number = '派13-318834', shokai_number = null, haken_detail_url = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/GICB102010.do?screenId=GICB102010&action=detail&detkey_Detail=%E6%B4%BE13-318834%2C1+++++', verified_at = now(), verified_by = 'reverify-2026-09-12' where domain = 'innovatia.co.jp';  -- 株式会社イノベイティア

-- ② 社名が一致する事業主を見つけられなかった会社。
--    「免許なし」とは言い切らず「照合できず」にする。絞り込み上の扱い（派遣案件に
--    出さない）は none と同じで、変えるのは言い切るかどうかだけ。
--    許可番号も外す（他社の番号が付いていることがあるため）。
update agent_companies set license_status = 'notfound', haken_number = null, shokai_number = null, haken_detail_url = null, verified_at = now(), verified_by = 'reverify-2026-09-12'
 where domain in (
   'mts-soft.co.jp',  -- 株式会社営業部
   'arm.jieshuyizhan.com',  -- 東京電力エナジーパートナー株式会社
   'e-studio.co.jp',  -- 株式会社イー・スタジオ
   'grato-inc.co.jp',  -- 株式会社グラート
   'tourai.co.jp',  -- 株式会社東来
   'allyute.com',  -- 株式会社アリュート
   'flexi-inc.com',  -- 株式会社Flexibility
   'edgecraft.jp',  -- EdgeCraftTech株式会社
   'dearism.co.jp',  -- 株式会社ディアリズム
   'b-engineer.com',  -- 株式会社Branding
   'fulwill.co.jp',  -- フルウィル株式会社
   'rightarm.co.jp',  -- ライトアーム株式会社
   'site-plan.com',  -- サイトプラン株式会社
   'uniquery.jp',  -- 株式会社Uniquery
   'asvento.co.jp',  -- 株式会社ASVENTO
   'webbolt.co.jp',  -- 株式会社ウェブボルト
   'laize.co.jp',  -- 株式会社ライズイノベーター
   'profuku.co.jp',  -- 株式会社プロ
   'clarify.co.jp',  -- クラリファイ株式会社
   'ipc-japan.com',  -- 株式会社アイ・ピー・コンサルタント
   'j-tech.co.jp',  -- 株式会社JapanTechnology
   'playgram.xyz',  -- PlayGram株式会社
   'gl-navi.co.jp',  -- GLナビゲーション株式会社
   'rekurashi.com',  -- 株式会社リクラシから
   'yatoya0828.jp',  -- 株式会社八と八
   'driven-x.com',  -- 株式会社DrivenX
   'ae-st.com',  -- ━━アエスト株式会社
   'matchsul.com',  -- マッチスル株式会社
   'mediahakase.com',  -- 株式会社博士ドットコム
   'make-system.jp',  -- 株式会社Make
   'second.fairgrit.com',  -- 株式会社SEcond
   'proud-g.jp',  -- 株式会社プラウドアドバンス
   'annusual.com',  -- USUAL株式会社
   'n-ic.jp',  -- Next IT Consulting株式会社
   'fstyle-inc.jp',  -- 株式会社FreeStyle
   'ntsjapan.com',  -- 株式会社NTS JAPAN
   'canon-mj.co.jp',  -- キヤノンマーケティングジャパン株式会社
   'refalke.co.jp',  -- 株式会社リファルケ
   'inari-solution.com',  -- 合同会社イナリソリューション
   'smes-chikara.co.jp',  -- 株式会社中小企業
   'sbt-inc.co.jp',  -- 株式会社ＳＢＴ
   'bartholojapan.jp',  -- (株)BartholoJapan
   'casleydi.co.jp',  -- キャスレーディープイノベーションズ株式会社
   'land-system.co.jp',  -- 株式会社VOICE
   'salesplus.dev',  -- 株式会社MOBIENT
   'ait.co.jp',  -- 6819_株式会社
   'plan-b.co.jp',  -- 株式会社PLAN-B
   'acro-net.com',  -- いしだより
   'mail.toshiba',  -- 08_27までにご返信下さい
   'apptech.jp',  -- 株式会社Apptech
   'thinkone.jp',  -- 株式会社シンクワン
   'alten.com',  -- 株式会社西日本営業部
   'lhplhp.biz',  -- 株式会社LHP
   'g-seed.co.jp',  -- React
   'goodpeace.jp',  -- 弊社HP：ぐっどぴーす株式会社
   'sq05.flysings.com',  -- ‍お​届
   'sq15.evanwrogers.com',  -- ‍お​届
   'mail-hakase.com',  -- 株式会社博士ドットコム
   'radstate.co.jp',  -- RADSTATE株式会社
   'racloud.co.jp',  -- 楽らクラウド株式会社
   'tanapism.co.jp',  -- タナピズム株式会社
   'prosperous-future.co.jp',  -- 株式会社プロスぺラス
   'enablementcon.com',  -- イネーブルメント株式会社
   'amazon.co.jp',  -- 最終通知
   'code-d.co.jp',  -- 株式会社D-code
   'a-proud.co.jp',  -- a-proud株式会社
   'laughter.inc',  -- 株式会社ラフター
   'digverse.co.jp',  -- Digverse株式会社
   'kokorozashi-japan.co.jp',  -- 株式会社ココロザシ
   'item-jp.com',  -- 株式会社アイテムソリューション
   'upsta-j.com',  -- 普段より株式会社
   'tj-micro.jp',  -- 株式会社TJ-micro
   'ma101.co.jp',  -- 株式会社マトイ
   'cityrebirth.com',  -- 株式会社シティリバース
   'lavesasy.me',  -- 株式会社クレディセゾン｜Credit Saison Co.
   'four-brains.co.jp',  -- 株式会社Example Co.
   'iliostar.co.jp',  -- イリオスター株式会社
   'jmkkk.hayuanyou.com',  -- Copyright 2026 iTunes K.K.
   'olvdnet.co.jp',  -- 株式会社オリーブドットネット
   'mail06.gecprogram.com',  -- 全日本空輸株式会社
   'smtpout.qinazxck.com',  -- 未処‌理
   'mail10.santinibros.com',  -- ays Co., Ltd.
   'esdt05.whhimin.com',  -- ‍お​届
   'communication.microsoft.com',  -- Microsoft Corporation
   'athlete-development-edge.com',  -- WADAX GMO, Inc.
   'stream.ocs-bet491.com',  -- NHK
   'mail12.huabang568.com',  -- 全日本空輸株式会社
   'gateway.lgobal.com',  -- 株式会社工ウレカ
   'mail.tisi.jp',  -- TISI株式会社
   'accountprotection.microsoft.com',  -- Microsoft Corporation
   'tmccorp.xyz',  -- 株式会社TMC村松
   'growth-innovation.tech',  -- 株式会社G&I
   'notificationemails.microsoft.com',  -- Microsoft Corporation
   'mail27.oxeqlws.cn',  -- o Mitsui Card Co., Ltd.
   'hr-team.co.jp',  -- (株)HR team
   'jfe-comservice.co.jp',  -- ご依頼
   'mail25.tongchaju.com',  -- Amazon Japan合同会社
   'news.proud-g.jp',  -- 株式会社プラウドデータ
   'microsoft.com',  -- Microsoft Corporation
   'esdii.org',  -- 重要
   'streak.co.jp',  -- 株式会社ストリーク
   'olive.style',  -- 株式会社Olive
   'maruco-inc.jp',  -- maruco株式会社
   'kobelcosys.co.jp',  -- コベルコソフトサービス株式会社
   'theoria-code.co.jp',  -- 株式会社テオリアコード
   'v-labo.co.jp',  -- 株式会社Vlabo
   'forengineer.co.jp',  -- 株式会社forEngineer
   'bitech.jp',  -- 株式会社バイテック
   'securemail.cqpcit.com',  -- AmazonInc
   'mail14.ocezh.com',  -- Amazon.com, Inc.
   'mejsys.co.jp',  -- 丸栄情報システム株式会社
   'mail13.yzmszm.com',  -- Amazon.com, Inc.
   'uooal.hbanjieda.com',  -- 株式会社クレディセ‌ゾンでは
   'routing.jingyongchou.com',  -- 全日本空輸株式会社
   'marketing.jzkwkj.com',  -- 楽天銀行株式会社
   'mail11.xinxivc.com',  -- 全日本空輸株式会社
   'mail33.hnahmy.com',  -- 重要
   'gateway.xikete.com',  -- 発行元：楽天カード株式会社
   'mail22.huchengw.com',  -- 重要
   'me.pikara.ne.jp',  -- WADAX GMO, Inc.
   'mail20.shzqhz.com',  -- 独立行政法人日本貿易振興機構
   'mail37.jzszl.com',  -- Amazon.com, Inc.
   'tisi.jp',  -- TISI株式会社
   'j-shiyaku.or.jp',  -- WADAX GMO, Inc.
   'mail27.pangwenwu.com',  -- 重要
   'clear-inc.site',  -- 株式会社リッチ
   'vv-e-nn.com',  -- 株式会社ジーンリバティー
   'techlab-inc.co.jp',  -- 株式会社Real Moi
   'world-link-system.com',  -- 株式会社ワールドリンク / 同名が複数 派11-300678,派14-303779,派27-304115
   'next-plus.jp',  -- 株式会社ネクストプラス / 同名が複数 派13-312196,派23-304222
   'mash.co.jp',  -- 株式会社マッシュ / 同名が複数 派13-303343,派14-300563,派27-302941
   'shaft.bz',  -- 株式会社シャフト / 同名が複数 派13-306061,派14-302113
   'extrapeach.jp',  -- Peach株式会社
   'i-genius.co.jp',  -- 株式会社ジーニアス / 同名が複数 派13-310550,派13-316762
   'cy-tech.jp',  -- 株式会社Knowledge
   'polaris-corp.co.jp',  -- 株式会社ポラリス / 同名が複数 派08-300366,派14-301841,派23-303244,派24-300573
   'h5j7k9l0.ylmsc.com',  -- 株式会社から
   'ai-more.co.jp',  -- 株式会社CyTechから社名変更
   'example.invalid',  -- 株式会社テスト
   'wakuto.net',  -- 株式会社ワクト / 同名が複数 派13-306823,派23-301609
   'bravance.co.jp',  -- 株式会社ブレイバンス
   'kanamekey.com',  -- KANAME社員
   'pia.co.jp',  -- ぴあ株式会社
   'wiz-tech.jp',  -- 株式会社WizTech━━━━━━━━━┓
   'cbs-n.com',  -- シービーエス株式会社 / 同名が複数 派13-310666,派13-311526
   'traver.jp'  -- 株式会社TRAVER
 );

commit;

-- ============================================================================
-- ここから先は会社名と行そのものの掃除（免許判定とは別トランザクション）。
-- 免許の修復だけ流して名前の掃除を保留したい場合は、ここから下を流さなくてよい。
-- ============================================================================

begin;

-- ③ 機械的に直せる会社名（元の文字列から確実に復元できるもの）
update agent_companies set company_name = 'アエスト株式会社'
 where domain = 'ae-st.com' and company_name = '━━アエスト株式会社';   -- 署名の罫線が混入
update agent_companies set company_name = '株式会社BartholoJapan'
 where domain = 'bartholojapan.jp' and company_name = '(株)BartholoJapan';
update agent_companies set company_name = '株式会社HR team'
 where domain = 'hr-team.co.jp' and company_name = '(株)HR team';
update agent_companies set company_name = '株式会社WizTech'
 where domain = 'wiz-tech.jp';  -- 「株式会社WizTech━━━━━━━━━┓」末尾の罫線

-- ④ 送ってきた人材側の from_company が正しい社名を持っていた行。
--    同じドメインから来た人材の多数決で決めた（推測ではない）。
--    ai-more.co.jp: 165人中158人が「株式会社ai・more」（社名は「株式会社CyTechから社名変更」だった）
update agent_companies set company_name = '株式会社ai・more'
 where domain = 'ai-more.co.jp';

-- ⑤ 会社名は取れなかったが許可番号は取れていた1社。番号から正式名称を復元した
--    （派13-306550 → 株式会社ウェブエッジ・2026-09-12 に厚労省サイトで確認）
update agent_companies set company_name = '株式会社ウェブエッジ'
 where domain = 'webedge.jp' and company_name is null;

-- ⑥ 社名が復元できない行（法人格＋部署名・一般語・数字だけ）で、人材を1人も生んでいないもの。
--    残しても「照合できず」から動かず、画面には誤った社名として並ぶ。
--    消してもドメインを覚えていないだけで、次に同じ会社からメールが来れば作り直される。
--    許可番号・メモを持つ行は誤って消さないよう条件で守る。
delete from agent_companies
 where domain in (
   'mts-soft.co.jp',        -- 株式会社営業部
   'alten.com',             -- 株式会社西日本営業部
   'smes-chikara.co.jp',    -- 株式会社中小企業
   'ait.co.jp',             -- 6819_株式会社
   'jfe-comservice.co.jp',  -- ご依頼
   'example.invalid'        -- 株式会社テスト（テスト用）
 )
 and haken_number is null and shokai_number is null
 and (memo is null or btrim(memo) = '');

-- ⑦ 会社名も許可番号も無い行（52件）。
--    verify-agent-license は社名で引くので、名前が無い行は永久に未確認のまま残る。
--    中身は迷惑メールの送信ドメイン・通知メール・test.local / example.com だった。
--    同時に inbound-email 側も「名前も番号も取れない送信元は登録しない」ように直した。
delete from agent_companies
 where (company_name is null or btrim(company_name) = '')
   and haken_number is null and shokai_number is null
   and (memo is null or btrim(memo) = '')
   and license_status = 'unknown'
   and source = 'email';

-- ⑧ 派遣会社ではない送信元（なりすましメール・サービスの通知メール）。
--    社名は本文から取れているが、その会社のドメインではない。
--    例:「東京電力エナジーパートナー株式会社」が arm.jieshuyizhan.com から届いている。
--    h5j7k9l0.ylmsc.com は「株式会社から」という社名で **派遣可** が付いていた
--    （旧実装が社名を照合せず、結果ページ先頭の「株式会社これから」の番号を採っていた）。
delete from agent_companies
 where domain in (
   'arm.jieshuyizhan.com',            -- 東京電力エナジーパートナー株式会社
   'h5j7k9l0.ylmsc.com',              -- 株式会社から（誤って派遣可が付いていた）
   'jmkkk.hayuanyou.com',             -- Copyright 2026 iTunes K.K.
   'mail06.gecprogram.com',           -- 全日本空輸株式会社
   'mail11.xinxivc.com',              -- 全日本空輸株式会社
   'mail12.huabang568.com',           -- 全日本空輸株式会社
   'routing.jingyongchou.com',        -- 全日本空輸株式会社
   'smtpout.qinazxck.com',            -- 未処理
   'mail10.santinibros.com',          -- ays Co., Ltd.
   'sq05.flysings.com',               -- お届
   'sq15.evanwrogers.com',            -- お届
   'esdt05.whhimin.com',              -- お届
   'stream.ocs-bet491.com',           -- NHK
   'gateway.lgobal.com',              -- 株式会社工ウレカ（エ→工 の誤字）
   'mail27.oxeqlws.cn',               -- o Mitsui Card Co., Ltd.
   'mail25.tongchaju.com',            -- Amazon Japan合同会社
   'securemail.cqpcit.com',           -- AmazonInc
   'mail14.ocezh.com',                -- Amazon.com, Inc.
   'mail13.yzmszm.com',               -- Amazon.com, Inc.
   'mail37.jzszl.com',                -- Amazon.com, Inc.
   'uooal.hbanjieda.com',             -- 株式会社クレディセゾンでは
   'marketing.jzkwkj.com',            -- 楽天銀行株式会社
   'gateway.xikete.com',              -- 発行元：楽天カード株式会社
   'mail20.shzqhz.com',               -- 独立行政法人日本貿易振興機構
   'mail33.hnahmy.com',               -- 重要
   'mail22.huchengw.com',             -- 重要
   'mail27.pangwenwu.com',            -- 重要
   'communication.microsoft.com',     -- Microsoft Corporation（通知メール）
   'accountprotection.microsoft.com', -- Microsoft Corporation（通知メール）
   'notificationemails.microsoft.com',-- Microsoft Corporation（通知メール）
   'me.pikara.ne.jp'                  -- WADAX GMO, Inc.（サーバの通知メール）
 )
 and (memo is null or btrim(memo) = '');

commit;

-- 掃除後の確認（実行しても副作用なし）
-- select license_status, count(*) from agent_companies group by 1 order by 2 desc;
