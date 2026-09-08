/**
 * cleanup-storage の削除対象パス絞り込みの回帰テスト。
 *
 * 掃除は Storage API のフォルダ走査をやめ、DB（storage.objects）に古いファイルを
 * 聞く方式に変えた。RPC が想定外のプレフィックスを返したときに掃除対象外を
 * 消してしまわないよう、削除直前に pathsUnderPrefix で関門を1枚置いている。
 * Storage の削除は取り返しがつかないので、ここは必ずテストで固定する。
 *
 * レプリカは作らず、**本番に出す index.ts から関数を切り出して**検証する。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../../supabase/functions/cleanup-storage/index.ts')

function load() {
  const src = readFileSync(SRC, 'utf8')
  const pick = (name: string) => {
    const m = src.match(new RegExp(`export function ${name}(?:<[^>]*>)?\\(([\\s\\S]*?)\\n\\}`))
    if (!m) throw new Error(`${name} を index.ts から取り出せませんでした`)
    return `function ${name}(${m[1]}\n}`
      .replace(/<T>/g, '')
      .replace(/: readonly T\[\]/g, '')
      .replace(/: T\[\]\[\]/g, '')
      .replace(/: readonly string\[\]/g, '')
      .replace(/: string\[\]/g, '')
      .replace(/: string/g, '')
      .replace(/: number/g, '')
  }
  const code = `
    ${pick('chunk')}
    ${pick('pathsUnderPrefix')}
    return { chunk, pathsUnderPrefix }
  `
  return new Function(code)() as {
    chunk: (items: string[], size: number) => string[][]
    pathsUnderPrefix: (paths: string[], prefix: string) => string[]
  }
}

const { chunk, pathsUnderPrefix } = load()

describe('pathsUnderPrefix', () => {
  it('対象フォルダ配下だけを残す', () => {
    const got = pathsUnderPrefix(
      ['raw/abc/1.xlsx', 'raw/def/2.pdf', 'resumes/3.pdf', 'other/4.txt', 'raw2/5.txt'],
      'raw',
    )
    expect(got).toEqual(['raw/abc/1.xlsx', 'raw/def/2.pdf'])
  })

  it('プレフィックスに / が付いていても同じ結果', () => {
    const paths = ['raw/a/1.xlsx', 'resumes/2.pdf']
    expect(pathsUnderPrefix(paths, 'raw/')).toEqual(['raw/a/1.xlsx'])
  })

  it('フォルダ名の前方一致で隣を巻き込まない', () => {
    // 'raw' で 'rawdata/' を消してはいけない
    expect(pathsUnderPrefix(['rawdata/1.txt'], 'raw')).toEqual([])
  })

  it('親をたどるパスは弾く', () => {
    expect(pathsUnderPrefix(['raw/../resumes/1.pdf', 'raw/a/../../x.txt'], 'raw')).toEqual([])
  })

  it('空入力は空', () => {
    expect(pathsUnderPrefix([], 'raw')).toEqual([])
  })
})

describe('chunk', () => {
  it('指定サイズで分割する', () => {
    expect(chunk(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('端数がなければ均等に割れる', () => {
    expect(chunk(['a', 'b', 'c', 'd'], 2)).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('件数がサイズ以下なら1つ', () => {
    expect(chunk(['a'], 100)).toEqual([['a']])
  })

  it('空入力は空', () => {
    expect(chunk([], 100)).toEqual([])
  })
})
