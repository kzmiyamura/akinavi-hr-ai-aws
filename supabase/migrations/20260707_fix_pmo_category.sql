-- Issue #120: PMOは「手法」ではなく役割寄りの語のため methodologies カテゴリから外す。
-- 役割としての表示は inbound-email 側の PROSE_ROLES に追加して対応する。
UPDATE skill_master SET category = 'others' WHERE name = 'PMO' AND category = 'methodologies';

-- candidate_skills は挿入時点のカテゴリを非正規化して保持しているため、
-- 既存レコードも合わせて更新（再解析なしで既存候補者の表示にも反映させる）
UPDATE candidate_skills SET category = 'others' WHERE skill = 'PMO' AND category = 'methodologies';
