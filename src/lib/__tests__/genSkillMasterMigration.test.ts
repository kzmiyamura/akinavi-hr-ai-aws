/**
 * 「この skill_master の行は git から戻せるか」の判定
 * （`scripts/gen_skill_master_migration.mjs`）。
 *
 * ■ なぜテストするか
 *   判定を誤ると **戻せない行を戻せると思い込む**。
 *   Supabase を Free に落とすと自動バックアップが無いので、
 *   取りこぼした行は壊した時点で永久に失われる。
 *
 * ■ ここで固定しているのは、実際に踏んだ3つの間違い
 *   1. ファイル全体を検索した → 「社内SE」が**役割テーブル**への INSERT に当たり、
 *      skill_master に無いのに「git にある」と誤判定した。
 *   2. 二重引用符も探した → 「UAT」がスキル『テスト』の
 *      **別名（jsonb の中）**に当たり、独立した行なのに見落とした。
 *   3. 自分の生成物を読んだ → 全部「git にある」ことになり、次回から0件になった。
 */
import { describe, it, expect } from 'vitest'

// @ts-expect-error — 控えからマイグレーションを起こす JS スクリプト（型定義なし）
import { extractSkillMasterStatements, isRecoverableFromGit, GENERATED_MARK } from '../../../scripts/gen_skill_master_migration.mjs'

/** 実物と同じ形。別名は jsonb 文字列なので中は二重引用符になる */
const SKILL_INSERT = `
INSERT INTO skill_master (name, category, aliases, source) VALUES
('テスト', 'methodologies', '["単体テスト","UAT","受入テスト"]'::jsonb, 'seed'),
('Java', 'languages', '["java"]'::jsonb, 'seed');
`

/** 別の表への INSERT。ここに出てくる名前を skill_master 扱いしてはいけない */
const ROLE_INSERT = `
INSERT INTO role_master (label, axis) VALUES
('社内SE', '事業'),
('ヘルプデスク', 'support');
`

describe('skill_master への文だけを取り出す', () => {
  it('skill_master の INSERT は拾う', () => {
    const s = extractSkillMasterStatements(SKILL_INSERT)
    expect(s).toContain("'Java'")
  })

  it('別の表への INSERT は拾わない（社内SE の取りこぼし）', () => {
    const s = extractSkillMasterStatements(ROLE_INSERT)
    expect(s).toBe('')
    expect(isRecoverableFromGit('社内SE', s)).toBe(false)
    expect(isRecoverableFromGit('ヘルプデスク', s)).toBe(false)
  })

  it('両方あるファイルでも、skill_master の分だけを見る', () => {
    const s = extractSkillMasterStatements(SKILL_INSERT + ROLE_INSERT)
    expect(isRecoverableFromGit('Java', s)).toBe(true)
    expect(isRecoverableFromGit('社内SE', s)).toBe(false)
  })

  it('別名を後から足す UPDATE も根拠として拾う', () => {
    const s = extractSkillMasterStatements(
      `UPDATE skill_master SET aliases = '["x"]'::jsonb WHERE name = 'Kubernetes';`)
    expect(isRecoverableFromGit('Kubernetes', s)).toBe(true)
  })

  it('コメントに名前があるだけでは拾わない', () => {
    const s = extractSkillMasterStatements(`-- 'Cisco' はまだ入れていない\nSELECT 1;`)
    expect(isRecoverableFromGit('Cisco', s)).toBe(false)
  })
})

describe('別名と行を取り違えない', () => {
  it('jsonb の別名に出てくるだけの名前は「git にある」と見なさない（UAT の取りこぼし）', () => {
    const s = extractSkillMasterStatements(SKILL_INSERT)
    // UAT は『テスト』の別名として "UAT" の形で出てくるが、独立した行ではない
    expect(s).toContain('"UAT"')
    expect(isRecoverableFromGit('UAT', s)).toBe(false)
  })

  it('行として入っている名前は「git にある」と見なす', () => {
    const s = extractSkillMasterStatements(SKILL_INSERT)
    expect(isRecoverableFromGit('テスト', s)).toBe(true)
  })

  it('部分一致で当てない（Java が JavaScript を飲み込まない）', () => {
    const s = extractSkillMasterStatements(
      `INSERT INTO skill_master (name) VALUES ('JavaScript');`)
    expect(isRecoverableFromGit('JavaScript', s)).toBe(true)
    expect(isRecoverableFromGit('Java', s)).toBe(false)
  })
})

describe('生成物を読み返さない', () => {
  it('生成物の目印が定義されている', () => {
    expect(GENERATED_MARK).toContain('git のどこにも残っていなかった')
  })

  it('実際に出力したマイグレーションには目印が入っている', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const p = 'supabase/migrations/20260928_seed_skill_master_manual.sql'
    // 生成前でもテストが落ちないようにする（CI で控えが無い場合）
    if (!existsSync(p)) return
    expect(readFileSync(p, 'utf8')).toContain(GENERATED_MARK)
  })
})
