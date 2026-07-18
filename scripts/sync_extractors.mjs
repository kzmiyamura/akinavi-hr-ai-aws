#!/usr/bin/env node
/**
 * sync_extractors.mjs — inbound-email/index.ts から純粋関数を抽出して JS に変換
 *
 * 使い方:
 *   node scripts/sync_extractors.mjs
 *
 * 出力: scripts/_extractors.gen.mjs（test_excel_parsing.mjs が import する）
 * index.ts の抽出関数が更新されたらこのスクリプトを再実行すること。
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC  = resolve(ROOT, 'supabase/functions/inbound-email/index.ts')
const DEST = resolve(ROOT, 'scripts/_extractors.gen.mjs')

// 抽出対象の関数名
const TARGET_FUNCTIONS = [
  'parseDurationToMonths',
  'excelSerialToDateStr',
  'parseYMParts',
  'calcMonthsFromMultilineCell',
  'calcMonthsFromDates',
  'filterSkillYears',
  'extractSkillYearsFromBodyText',
  'extractSkillYearsFromSheetData',
]

// ── TypeScript → JavaScript 簡易変換 ──────────────────────────────

// 既知のTypeScript型名（これらに続く <...> だけを除去する）
const TS_TYPE_NAMES = /^(?:Record|Array|Set|Map|Promise|ReadonlyArray|Partial|Required|Readonly|NonNullable|Extract|Exclude|ReturnType|RegExpExecArray)$/

/**
 * 正規表現リテラルをプレースホルダに退避する。
 * stripTs の後置!除去などのテキスト変換が正規表現リテラル内の文字
 * （例: /#REF!|NUM!/ の「!」）を破壊する実害があったため、変換前に退避して最後に戻す。
 * 判定: 直前の有意文字が演算子・区切り（= ( , : [ ! & | ? ; { } return）なら正規表現、
 * オペランド末尾（識別子・数値・) ]）なら除算として扱う。文字列・コメントはスキップ。
 */
function maskRegexLiterals(code) {
  const literals = []
  let out = ''
  let i = 0
  let prevSig = ''  // 直前の有意文字（空白以外・コメント除く）
  const REGEX_PRECEDING = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', ';', '{', '}', '\n'])
  while (i < code.length) {
    const ch = code[i]
    if (ch === '/' && code[i + 1] === '/') {
      const j = code.indexOf('\n', i)
      const seg = code.slice(i, j === -1 ? code.length : j)
      out += seg; i += seg.length; continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const j = code.indexOf('*/', i)
      const seg = code.slice(i, j === -1 ? code.length : j + 2)
      out += seg; i += seg.length; continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') j += 2
        else if (code[j] === ch) { j++; break }
        else j++
      }
      out += code.slice(i, j); prevSig = ch; i = j; continue
    }
    if (ch === '/') {
      const isRegex = REGEX_PRECEDING.has(prevSig) || /\breturn$/.test(out.trimEnd())
      if (isRegex) {
        let j = i + 1
        let inClass = false
        while (j < code.length) {
          const c = code[j]
          if (c === '\\') { j += 2; continue }
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) { j++; break }
          else if (c === '\n') break  // 改行を跨いだら正規表現ではなかった（安全側で除算扱い）
          j++
        }
        if (code[j - 1] === '/') {
          while (j < code.length && /[gimsuy]/.test(code[j])) j++
          literals.push(code.slice(i, j))
          out += `__REGEX_LIT_${literals.length - 1}__`
          prevSig = '/'
          i = j
          continue
        }
      }
      out += ch; prevSig = ch; i++; continue
    }
    out += ch
    if (!/\s/.test(ch)) prevSig = ch
    i++
  }
  return { code: out, literals }
}

function unmaskRegexLiterals(code, literals) {
  return code.replace(/__REGEX_LIT_(\d+)__/g, (_, n) => literals[Number(n)])
}

function stripTs(code) {
  // 0. 正規表現リテラルを退避（変換による破壊防止。最後に復元する）
  const masked = maskRegexLiterals(code)
  code = masked.code
  // 1. インターフェース・type定義を削除
  code = code.replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+[^{]*\{[^}]*\}\s*\n/gm, '')
  code = code.replace(/^\s*type\s+\w+\s*=\s*.+;\s*\n/gm, '')

  // 2. as Type キャスト（"as string", "as any" 等）— 比較演算子の > は含まない
  code = code.replace(/\bas\s+(?:string|number|boolean|unknown|any|null|undefined|\w+)/g, '')

  // 3. 既知TypeScript型名に続く <...> だけ除去（比較演算子は除外）
  //    Record<string, number>, Array<string>, RegExpExecArray|null 等
  code = code.replace(/\b(Record|Array|Set|Map|Promise|ReadonlyArray|RegExpExecArray)<[^>]*>/g, (_m, name) => {
    return name === 'Array' ? '[]' : '__REMOVED_TYPE__'
  })
  // __REMOVED_TYPE__ が変数宣言の型注釈位置に残っている場合は削除
  code = code.replace(/\s*:\s*__REMOVED_TYPE__\s*(?=[=])/g, '')
  // パラメータ位置に残っている場合
  code = code.replace(/(\b\w+)\s*:\s*__REMOVED_TYPE__(?=\s*[,)])/g, '$1')
  // 戻り値型位置
  code = code.replace(/\)\s*:\s*__REMOVED_TYPE__\s*(?=[{(]|=>|\n)/g, ')')
  // 残留クリーンアップ
  code = code.replace(/:\s*__REMOVED_TYPE__/g, '')

  // 3b. アロー関数の戻���値型 (param): ReturnType =>  →  (param) =>
  code = code.replace(/\)\s*:\s*(?:string|number|boolean|void|null|undefined)(?:\[\])*(?:\s*\|\s*(?:string|number|boolean|null|undefined)(?:\[\])*)*\s*(?==>)/g, ')')
  code = code.replace(/\)\s*:\s*[A-Z]\w*(?:\[\])*\s*(?==>)/g, ')')
  // (segment): string[] => { 形式
  code = code.replace(/\)\s*:\s*[\w[\] |&]+\s*(?==>)/g, ')')

  // 4. 戻り値型注釈 ): Type {  or ): Type =>  or ): Type\n
  //    コロンの直後が型名（大文字始まりや string|null 等）の場合のみ除去
  code = code.replace(/\)\s*:\s*(?:string|number|boolean|void|null|undefined)(?:\s*\|\s*(?:string|number|boolean|void|null|undefined))*\s*(?=[\n{(=]|=>)/g, ')')
  // ): TypeName { / ): TypeName[] {
  code = code.replace(/\)\s*:\s*[A-Z]\w*(?:\[\])*\s*(?=[{\n]|=>)/g, ')')

  // 5. パラメータ型注釈 (param: type) — コロン後が型名の場合
  //    シンプルな型: string, number, boolean, null, unknown, any
  code = code.replace(/(\b\w+)\s*:\s*(?:string|number|boolean|null|unknown|any|void)(?:\s*\[\])*(?=\s*[,)=])/g, '$1')
  // string[][] / string[] / number[] の配列型
  code = code.replace(/(\b\w+)\s*:\s*string\[\]\[\](?=\s*[,)=])/g, '$1')
  code = code.replace(/(\b\w+)\s*:\s*string\[\](?=\s*[,)=])/g, '$1')
  code = code.replace(/(\b\w+)\s*:\s*number\[\](?=\s*[,)=])/g, '$1')
  // ユニオン型 string | null 等
  code = code.replace(/(\b\w+)\s*:\s*(?:string|number|boolean)\s*\|\s*(?:string|number|boolean|null|undefined)(?=\s*[,)=])/g, '$1')

  // 6. 変数型注釈 let/const x: Type  (= あり・なし両方)
  //    シンプルな型 + ユニオン型 + 大文字始まりクラス名 + 空オブジェクト
  code = code.replace(/\b(const|let|var)\s+(\w+)\s*:\s*(?:[A-Z]\w*(?:\s*\|\s*\w+)*|[\w[\]]+(?:\s*\|\s*[\w[\]]+)*)\s*(?=[=\n;])/g, '$1 $2')
  // let m: RegExpExecArray | null のような宣言のみ（= なし）
  code = code.replace(/\b(let|const|var)\s+(\w+)\s*:\s*[\w[\] |&]+\s*$/gm, '$1 $2')

  // 7. for...of 変数型
  code = code.replace(/\b(const|let)\s+(\w+)\s*:\s*[\w[\]|& ]+\s+(of|in)\b/g, '$1 $2 $3')

  // 8. 後置 ! (non-null assertion) — !=, !== は保護
  code = code.replace(/([a-zA-Z0-9_$'")\]])\s*!(?!=)/g, '$1')

  // 9. 退避した正規表現リテラルを復元
  return unmaskRegexLiterals(code, masked.literals)
}

// ── 関数本体抽出 ──────────────────────────────────────────────────

function extractFunction(src, name) {
  const startRe = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`, 'm')
  const startMatch = startRe.exec(src)
  if (!startMatch) return null

  // 関数開始行から波括弧カウントで終端を探す
  let pos = startMatch.index
  // 関数シグネチャの最初の { を探す
  let braceStart = src.indexOf('{', pos)
  if (braceStart === -1) return null

  let depth = 0
  let i = braceStart
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }

  const body = src.slice(startMatch.index, i + 1)
  return body
}

// ── メイン ────────────────────────────────────────────────────────

const src = readFileSync(SRC, 'utf-8')

const extracted = []
const missing = []

for (const name of TARGET_FUNCTIONS) {
  const body = extractFunction(src, name)
  if (!body) { missing.push(name); continue }
  const js = stripTs(body)
  extracted.push({ name, js })
}

if (missing.length > 0) {
  console.warn(`⚠️  以下の関数が見つかりませんでした: ${missing.join(', ')}`)
}

const output = [
  `// AUTO-GENERATED by scripts/sync_extractors.mjs`,
  `// DO NOT EDIT — ${new Date().toISOString().slice(0, 10)} に index.ts から生成`,
  `// 再生成: node scripts/sync_extractors.mjs`,
  ``,
  ...extracted.map(({ name, js }) => `// ── ${name} ──\n${js}\n`),
  ``,
  `export {`,
  ...extracted.map(({ name }) => `  ${name},`),
  `}`,
].join('\n')

writeFileSync(DEST, output, 'utf-8')
console.log(`✅ _extractors.gen.mjs を生成しました（${extracted.length}関数）`)
if (missing.length > 0) console.log(`   未取得: ${missing.join(', ')}`)
