/**
 * 経歴書をローカル控えから読む仕組みの判定（`scripts/llm_extract/local_resume.mjs`）。
 *
 * ■ ここで固定したいこと
 *   1. Storage のファイル名から内容ハッシュを正しく取り出せること。
 *      取り違えると**別人の経歴書を読む**。20桁の16進という形だけが手がかりなので、
 *      名前に数字が入る・クエリが付く・URLエンコードされている形を全部通す。
 *   2. ハッシュの作り方が inbound-email の `stableResumeName()` と一致すること
 *      （base64 文字列を sha256 して先頭20桁）。ずれると命中率が0になる。
 *   3. **当たらないときは必ず null を返し、例外を投げないこと。**
 *      投げると AI校正がその人で止まる。Storage への退避が常に残らなければならない。
 *   4. 控えが索引にあっても**実ファイルが消えていたら null**。
 *      人が消す・D: が外れることがある。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

// @ts-expect-error — 常駐ワーカーが使う JS モジュール（型定義なし）
import { extractStorageHash, hashFileBytes, refreshLocalResumeIndex, resolveLocalResume, storeLocalResume, _resetCache } from '../../../scripts/llm_extract/local_resume.mjs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'akinavi-localresume-'))
  _resetCache()
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 控えと同じ形（<root>/<日付>/<メールの鍵>/<連番>_<名前>）にファイルを置く */
function putArchived(day: string, mailKey: string, name: string, content: string) {
  const dir = join(root, day, mailKey)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
  return content
}

const today = () => new Date().toISOString().slice(0, 10)

describe('Storage名からハッシュを取り出す', () => {
  it('通常の形', () => {
    expect(extractStorageHash('https://x.supabase.co/a/b/K_T_0123456789abcdef0123.xlsx'))
      .toBe('0123456789abcdef0123')
  })

  it('名前に数字やアンダースコアが入っていても末尾のハッシュを取る', () => {
    expect(extractStorageHash('https://x/_01_MK_2026_aaaaaaaaaaaaaaaaaaaa.xlsx'))
      .toBe('aaaaaaaaaaaaaaaaaaaa')
  })

  it('URLエンコードされた日本語名でも取れる', () => {
    const url = 'https://x/' + encodeURIComponent('スキルシート') + '_bbbbbbbbbbbbbbbbbbbb.xlsx'
    expect(extractStorageHash(url)).toBe('bbbbbbbbbbbbbbbbbbbb')
  })

  it('クエリが付いていても取れる（署名付きURL）', () => {
    expect(extractStorageHash('https://x/A_cccccccccccccccccccc.pdf?token=abc'))
      .toBe('cccccccccccccccccccc')
  })

  it('ハッシュを持たない名前は null（旧い命名・手で置いたファイル）', () => {
    for (const u of ['https://x/resume.xlsx', 'https://x/A_short.xlsx', '', null, undefined]) {
      expect(extractStorageHash(u as string)).toBeNull()
    }
  })

  it('16進でない20文字は取らない（別人を読む事故を防ぐ）', () => {
    expect(extractStorageHash('https://x/A_zzzzzzzzzzzzzzzzzzzz.xlsx')).toBeNull()
  })
})

describe('ハッシュの作り方が inbound-email と一致する', () => {
  it('base64 文字列を sha256 して先頭20桁', () => {
    const buf = Buffer.from('hello resume')
    const expected = createHash('sha256').update(buf.toString('base64')).digest('hex').slice(0, 20)
    expect(hashFileBytes(buf)).toBe(expected)
    expect(hashFileBytes(buf)).toHaveLength(20)
  })
})

describe('索引と照合', () => {
  it('控えにあるファイルを引ける', () => {
    const body = 'xlsx bytes here'
    putArchived(today(), 'mail-1', '01_skillsheet.xlsx', body)
    const r = refreshLocalResumeIndex({ root })
    expect(r?.added).toBe(1)

    const hash = hashFileBytes(Buffer.from(body))
    const found = resolveLocalResume(`https://x/K_T_${hash}.xlsx`, { root, boxRoot: null })
    expect(found).toContain('01_skillsheet.xlsx')
  })

  it('同じ中身なら名前が違っても当たる（内容ハッシュなので）', () => {
    const body = '同じ経歴書'
    putArchived(today(), 'mail-1', '01_A社_提案.xlsx', body)
    refreshLocalResumeIndex({ root })
    const hash = hashFileBytes(Buffer.from(body))
    // Storage 側は人材名から付けた別の名前になっている
    expect(resolveLocalResume(`https://x/Y_S_${hash}.xlsx`, { root, boxRoot: null })).toBeTruthy()
  })

  it('控えに無ければ null（Storageから落とす動作に退避する）', () => {
    putArchived(today(), 'mail-1', '01_a.xlsx', 'A')
    refreshLocalResumeIndex({ root })
    expect(resolveLocalResume('https://x/A_dddddddddddddddddddd.xlsx', { root, boxRoot: null })).toBeNull()
  })

  it('索引にあっても実ファイルが消えていたら null', () => {
    const body = 'B'
    putArchived(today(), 'mail-1', '01_b.xlsx', body)
    refreshLocalResumeIndex({ root })
    const hash = hashFileBytes(Buffer.from(body))
    expect(resolveLocalResume(`https://x/B_${hash}.xlsx`, { root, boxRoot: null })).toBeTruthy()

    rmSync(join(root, today(), 'mail-1'), { recursive: true, force: true })
    _resetCache()
    expect(resolveLocalResume(`https://x/B_${hash}.xlsx`, { root, boxRoot: null })).toBeNull()
  })

  it('原本メールと管理ファイルは索引に入れない', () => {
    putArchived(today(), 'mail-1', 'message.json', '{}')
    putArchived(today(), 'mail-1', 'message.msg', 'MSG')
    putArchived(today(), 'mail-1', '_note.txt', 'x')
    expect(refreshLocalResumeIndex({ root })?.added).toBe(0)
  })

  it('二度目は読み直さない（増分更新）', () => {
    putArchived(today(), 'mail-1', '01_a.xlsx', 'A')
    expect(refreshLocalResumeIndex({ root })?.added).toBe(1)
    expect(refreshLocalResumeIndex({ root })?.added).toBe(0)
    putArchived(today(), 'mail-2', '01_b.xlsx', 'B')
    expect(refreshLocalResumeIndex({ root })?.added).toBe(1)
  })

  it('sinceDays より古い日付フォルダは見ない', () => {
    putArchived('2020-01-01', 'old', '01_old.xlsx', 'OLD')
    expect(refreshLocalResumeIndex({ root, sinceDays: 3 })?.added).toBe(0)
    expect(refreshLocalResumeIndex({ root, sinceDays: null })?.added).toBe(1)
  })
})

/**
 * Box 由来（メールに添付されていない経歴書）の控え。
 * ここが効かないと、Storage の7日保持が切れた時点で原本がどこにも無くなる。
 */
describe('Box 由来の控えを書いて読む', () => {
  it('書いたファイルを Storage の URL から引ける', () => {
    const buf = Buffer.from('box xlsx bytes')
    const kept = storeLocalResume(buf, 'スキルシート 山田.xlsx', { root })
    expect(kept?.existed).toBe(false)
    expect(kept?.bytes).toBe(buf.length)
    // ハッシュは内容由来＝Storage のファイル名と必ず一致する
    expect(kept?.hash).toBe(hashFileBytes(buf))
    // 置き場所は <日付>/<ハッシュ>_<無害化した名前>。日本語・空白は `_` にする
    expect(kept!.path.endsWith(`${kept!.hash}_${'_'.repeat(9)}.xlsx`)).toBe(true)
    expect(kept!.path).toContain(today())

    const found = resolveLocalResume(`https://x/Y_M_${kept!.hash}.xlsx`, { root: join(root, 'nope'), boxRoot: root })
    expect(found).toBe(kept!.path)
  })

  it('同じ中身を二度書かない（existed=true で返る）', () => {
    const buf = Buffer.from('same bytes')
    expect(storeLocalResume(buf, 'a.xlsx', { root })?.existed).toBe(false)
    expect(storeLocalResume(buf, 'a.xlsx', { root })?.existed).toBe(true)
  })

  it('メール控えが先・無ければ Box 控えを見る', () => {
    const mailBuf = 'mail side'
    putArchived(today(), 'mail-1', '01_m.xlsx', mailBuf)
    refreshLocalResumeIndex({ root })
    const boxRoot = mkdtempSync(join(tmpdir(), 'akinavi-box-'))
    try {
      const boxKept = storeLocalResume(Buffer.from('box side'), 'b.xlsx', { root: boxRoot })
      const mailHash = hashFileBytes(Buffer.from(mailBuf))
      expect(resolveLocalResume(`https://x/A_${mailHash}.xlsx`, { root, boxRoot })).toContain('01_m.xlsx')
      expect(resolveLocalResume(`https://x/A_${boxKept!.hash}.xlsx`, { root, boxRoot })).toBe(boxKept!.path)
    } finally { rmSync(boxRoot, { recursive: true, force: true }) }
  })

  it('経歴書でない拡張子は控えない（索引に入れても使えない）', () => {
    expect(storeLocalResume(Buffer.from('x'), 'note.txt', { root })).toBeNull()
    expect(storeLocalResume(Buffer.from('x'), 'image.png', { root })).toBeNull()
  })

  it('空・名前なし・書けない場所でも例外を投げない', () => {
    expect(storeLocalResume(Buffer.alloc(0), 'a.xlsx', { root })).toBeNull()
    expect(storeLocalResume(Buffer.from('x'), null, { root })).toBeNull()
    expect(storeLocalResume(null, 'a.xlsx', { root })).toBeNull()
  })
})

describe('壊れていても止めない', () => {
  it('控えのフォルダが無くても例外を投げない', () => {
    const missing = join(root, 'no-such-dir')
    expect(refreshLocalResumeIndex({ root: missing })).toBeNull()
    expect(resolveLocalResume('https://x/A_eeeeeeeeeeeeeeeeeeee.xlsx', { root: missing, boxRoot: null })).toBeNull()
  })

  it('索引が壊れていても例外を投げない', () => {
    writeFileSync(join(root, '_resume_index.json'), '{ これはJSONではない')
    _resetCache()
    expect(resolveLocalResume('https://x/A_ffffffffffffffffffff.xlsx', { root, boxRoot: null })).toBeNull()
    // 壊れた索引は空として扱い、作り直せる
    putArchived(today(), 'mail-1', '01_a.xlsx', 'A')
    expect(refreshLocalResumeIndex({ root })?.added).toBe(1)
  })
})
