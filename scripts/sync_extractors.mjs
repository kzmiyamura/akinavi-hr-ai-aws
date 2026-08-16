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
  'unionIntervalMonths',
  'scoreSkillQuality',
  'gridToJsonRows',
  'extractSkillYearsFromSheetJson',
  'extractSkillYearsUnified',
  'calcMonthsFromMultilineCell',
  'calcMonthsFromDates',
  'filterSkillYears',
  'extractSkillYearsFromBodyText',
  'extractSkillYearsFromSheetData',
  'looksLikeRosterName',
  'personAttrScore',
  'isOwnersResumeFile',
  'assignAttachmentsToBlocks', // ブロック×添付の全体最適割当（管理番号マッチ含む）
  'stripInitialSuffix',
  'extractNationalityMark',
  'isValidNationality',
  'stationNameCandidates',
  'extractWorkStyleNote',
  'findWorkStyleIn',        // extractWorkStyleNote が呼ぶ（本文優先・添付は案件説明を弾く）
  'extractLicenseNumbers',  // 派遣・職業紹介の許可番号（旧表記 般/特・全角に対応）
  'deriveWorkStyleTag',
  'extractSkillYearsVisualProject',    // 案件ブロック区間union（_extractMethod=61）
  'projSplitTokens',                   // ↑が呼ぶトークン分割
  'projParseKakko',                    // ↑が呼ぶ【カテゴリ】/接頭辞の解釈
  'extractSkillYearsFromCareerBlocks', // 叙述型の職務経歴書（主にPDF）の期間ブロック×スキル
  '_careerTermRe',                     // ↑が呼ぶ語境界つき照合regex
  'projParsePeriod',                   // ↑が呼ぶ期間パーサ（Excel視覚エンジンと共用）
  'projMergeMonths',                   // ↑が呼ぶ区間union
  '_cachedSkillRegex',                 // _careerTermRe が呼ぶregexキャッシュ
  'extractSkillYearsFromCells',
  'extractSkillYearsPeriodHeader',
  'extractSkillYearsRepeatPeriodHeader',
  'extractSkillYearsCircledNum',
  'decodeXlsxRange',
  'encodeXlsxCell',
  'cellToText',
  'worksheetToGrid',
  'worksheetToCells',
  'scoreProseRoles',
  'sameMailConflicts',      // 同一メール内の同名を別人と判定する（駅・県・年齢・単価の食い違い）
  'mergeRawProfileOnUpdate', // 既存レコード上書き時の raw_profile 合成（AI校正の印は引き継がない）
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

  // 1b. 関数宣言のジェネリクス `function foo<T extends {...}>(` → `function foo(`
  //     （assignAttachmentsToBlocks 等。`>(` の最初の出現までを非貪欲で除去）
  code = code.replace(/(function\s+\w+)\s*<[^(]*?>\s*\(/g, '$1(')

  // 2. as Type キャスト（"as string", "as any" 等）— 比較演算子の > は含まない
  code = code.replace(/\bas\s+(?:string|number|boolean|unknown|any|null|undefined|\w+)(?:\[\])*(?:\s*\|\s*(?:\w+)(?:\[\])*)*/g, '')

  // 2b. オブジェクトリテラル型の戻り値注釈 `): { s: {...}; e: {...} } {` → `) {`
  //     （decodeXlsxRange 等。ネストした {} を括弧対応で数えて丸ごと除去）
  {
    const RE = /\)\s*:\s*\{/g
    let m2
    while ((m2 = RE.exec(code)) !== null) {
      const idx = m2.index
      const braceStart = code.indexOf('{', code.indexOf(':', idx))
      let depth = 0
      let j = braceStart
      for (; j < code.length; j++) {
        if (code[j] === '{') depth++
        else if (code[j] === '}') { depth--; if (depth === 0) { j++; break } }
      }
      // 型注釈の閉じ括弧の後に関数本体の `{` か `=>` が続く場合のみ型注釈とみなす
      const rest = code.slice(j).match(/^\s*(\{|=>)/)
      if (depth === 0 && rest) {
        code = code.slice(0, idx + 1) + code.slice(j)
        RE.lastIndex = idx + 1  // 除去後の位置から再走査
      }
      // 型注釈でない場合はそのまま次のマッチへ（lastIndex は正規表現が前進済み）
    }
  }

  // 2c. 変数宣言のオブジェクトリテラル型注釈 `const heads: { line: number }[] = []` → `const heads = []`
  //     （2b は戻り値注釈だけを見ているのでこちらは素通りし、`const x: {` が残って
  //      「Missing initializer in const declaration」で落ちる）
  {
    const RE = /\b(const|let|var)\s+(\w+)\s*:\s*\{/g
    let m3
    while ((m3 = RE.exec(code)) !== null) {
      const braceStart = code.indexOf('{', m3.index + m3[0].length - 1)
      let depth = 0
      let j = braceStart
      for (; j < code.length; j++) {
        if (code[j] === '{') depth++
        else if (code[j] === '}') { depth--; if (depth === 0) { j++; break } }
      }
      if (depth !== 0) continue
      // 型注釈の後は `[]` の繰り返しやユニオン（`| null` 等）を挟んで `=` が来るはず。
      // 来なければ型注釈ではない
      const rest = code.slice(j).match(/^(\s*(?:\[\])*(?:\s*\|\s*[\w[\]]+)*)\s*=/)
      if (!rest) continue
      code = code.slice(0, m3.index) + `${m3[1]} ${m3[2]} ` + code.slice(j + rest[1].length)
      RE.lastIndex = m3.index
    }
  }

  // 3. 既知TypeScript型名に続く <...> を括弧対応を数えて丸ごと除去。
  //    旧実装は [^>]* の非貪欲マッチだったため Array<Record<string, string>> のような
  //    入れ子ジェネリクスで内側の > までしか消えず、壊れたJSを生成する実害があった
  {
    const GENERIC_NAMES = ['Record', 'Array', 'Set', 'Map', 'Promise', 'ReadonlyArray', 'Partial', 'RegExpExecArray']
    let changed = true
    while (changed) {
      changed = false
      for (const name of GENERIC_NAMES) {
        let idx = 0
        while ((idx = code.indexOf(name + '<', idx)) !== -1) {
          const prev = code[idx - 1]
          if (prev && /[\w$]/.test(prev)) { idx += name.length; continue }  // 別識別子の一部
          let depth = 0
          let j = idx + name.length
          for (; j < code.length; j++) {
            if (code[j] === '<') depth++
            else if (code[j] === '>') { depth--; if (depth === 0) { j++; break } }
            else if (code[j] === '\n') break  // 行を跨ぐ比較演算子等は対象外
          }
          if (depth === 0 && code[j - 1] === '>') {
            // `new Set<string>()` 等のコンストラクタ呼び出しでは型引数だけ落として
            // クラス名は残す（型注釈位置なら従来どおり __REMOVED_TYPE__ に置換して後段で除去）
            const before = code.slice(0, idx).trimEnd()
            if (/\bnew$/.test(before)) {
              code = code.slice(0, idx) + name + code.slice(j)
            } else {
              code = code.slice(0, idx) + '__REMOVED_TYPE__' + code.slice(j)
            }
            changed = true
          } else {
            idx += name.length
          }
        }
      }
    }
  }
  // __REMOVED_TYPE__ が変数宣言の型注釈位置に残っている場合は削除
  code = code.replace(/\s*:\s*__REMOVED_TYPE__\s*(?=[=])/g, '')
  // パラメータ位置に残っている場合
  code = code.replace(/(\b\w+)\s*:\s*__REMOVED_TYPE__(?=\s*[,)])/g, '$1')
  // 戻り値型位置
  // ユニオン付き（`): Record<string, number> | null {`）も対象にする
  code = code.replace(/\)\s*:\s*__REMOVED_TYPE__(?:\s*\|\s*(?:__REMOVED_TYPE__|[\w[\]]+))*\s*(?=[{(]|=>|\n)/g, ')')
  // 残留クリーンアップ
  code = code.replace(/:\s*__REMOVED_TYPE__/g, '')

  // 3b. アロー関数の戻���値型 (param): ReturnType =>  →  (param) =>
  code = code.replace(/\)\s*:\s*(?:string|number|boolean|void|null|undefined)(?:\[\])*(?:\s*\|\s*(?:string|number|boolean|null|undefined)(?:\[\])*)*\s*(?==>)/g, ')')
  code = code.replace(/\)\s*:\s*[A-Z]\w*(?:\[\])*\s*(?==>)/g, ')')
  // (segment): string[] => { 形式
  code = code.replace(/\)\s*:\s*[\w[\] |&]+\s*(?==>)/g, ')')

  // 4. 戻り値型注釈 ): Type {  or ): Type =>  or ): Type\n
  //    コロンの直後が型名（大文字始まりや string|null 等）の場合のみ除去
  code = code.replace(/\)\s*:\s*(?:string|number|boolean|void|null|undefined)(?:\[\])*(?:\s*\|\s*(?:string|number|boolean|void|null|undefined)(?:\[\])*)*\s*(?=[\n{(=]|=>)/g, ')')
  // ): TypeName { / ): TypeName[] {
  code = code.replace(/\)\s*:\s*[A-Z]\w*(?:\[\])*\s*(?=[{\n]|=>)/g, ')')

  // 5. パラメータ型注釈 (param: type) — コロン後が型名の場合
  //    シンプルな型: string, number, boolean, null, unknown, any
  //    null 単体は対象外。オブジェクトリテラルの `{ start: null, end: null }` を
  //    型注釈と誤認して `{ start, end }` に潰す実害があった（projParsePeriod）。
  //    `string | null` のようなユニオンは後段の規則が扱う
  code = code.replace(/(\b\w+)\s*:\s*(?:string|number|boolean|unknown|any|void)(?:\s*\[\])*(?=\s*[,)=])/g, '$1')
  // string[][] / string[] / number[] の配列型
  code = code.replace(/(\b\w+)\s*:\s*string\[\]\[\](?=\s*[,)=])/g, '$1')
  code = code.replace(/(\b\w+)\s*:\s*string\[\](?=\s*[,)=])/g, '$1')
  code = code.replace(/(\b\w+)\s*:\s*number\[\](?=\s*[,)=])/g, '$1')
  // ユニオン型 string | null 等
  code = code.replace(/(\b\w+)\s*:\s*(?:string|number|boolean)\s*\|\s*(?:string|number|boolean|null|undefined)(?=\s*[,)=])/g, '$1')
  // 5b. カスタム型（大文字始まりクラス名）パラメータ: SpanCell[] / XlsxCell | undefined 等
  code = code.replace(/(\b\w+)\s*:\s*[A-Z]\w*(?:\[\])*(?:\s*\|\s*(?:[A-Z]\w*(?:\[\])*|null|undefined))*(?=\s*[,)=])/g, '$1')
  // 5c. タプル型パラメータ: iv: [number, number][] （projMergeMonths 等の区間配列）
  code = code.replace(/(\b\w+)\s*:\s*\[[^\][]*\](?:\[\])*(?=\s*[,)=])/g, '$1')
  // 6. 変数型注釈 let/const x: Type  (= あり・なし両方)
  //    シンプルな型 + ユニオン型 + 大文字始まりクラス名 + 空オブジェクト
  code = code.replace(/\b(const|let|var)\s+(\w+)\s*:\s*(?:[A-Z]\w*(?:\s*\|\s*\w+)*|[\w[\]]+(?:\s*\|\s*[\w[\]]+)*)\s*(?=[=\n;])/g, '$1 $2')
  // let m: RegExpExecArray | null のような宣言のみ（= なし）
  code = code.replace(/\b(let|const|var)\s+(\w+)\s*:\s*[\w[\] |&]+\s*$/gm, '$1 $2')

  // 7. for...of 変数型
  code = code.replace(/\b(const|let)\s+(\w+)\s*:\s*[\w[\]|& ]+\s+(of|in)\b/g, '$1 $2 $3')

  // 8. 後置 ! (non-null assertion) — !=, !== は保護。
  //    後置断定は必ず直前トークンに密着する（foo! / )!）ため空白は許さない。
  //    旧実装は \s* を挟んでいたため「return !isNaN(x)」の論理否定まで除去する実害があった
  // 文字列リテラル先頭の ! （'!merges' 等）を壊さないよう、引用符は対象から外す
  // （obj['key']! のような後置断定は ]! でカバーされる）
  code = code.replace(/([a-zA-Z0-9_$)\]])!(?!=)/g, '$1')

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
  // 関数シグネチャの最初の { を探す。ただし戻り値がオブジェクトリテラル型
  // （`): { s: {...} } {`）の場合、型注釈の { を本体と誤認しないよう、
  // パラメータ閉じ括弧後に `: {` が続くなら型注釈の括弧対応をスキップして本体 { を探す
  let braceStart = src.indexOf('{', pos)
  if (braceStart === -1) return null
  {
    // パラメータリストの閉じ ) を括弧対応で見つける
    const parenStart = src.indexOf('(', pos)
    if (parenStart !== -1 && parenStart < braceStart) {
      let pd = 0, k = parenStart
      for (; k < src.length; k++) {
        if (src[k] === '(') pd++
        else if (src[k] === ')') { pd--; if (pd === 0) { k++; break } }
      }
      const afterParen = src.slice(k)
      const typeM = afterParen.match(/^\s*:\s*\{/)
      if (typeM) {
        // 型注釈オブジェクトの括弧対応を数えて読み飛ばす
        let td = 0, t = k + typeM[0].length - 1
        for (; t < src.length; t++) {
          if (src[t] === '{') td++
          else if (src[t] === '}') { td--; if (td === 0) { t++; break } }
        }
        const bodyBrace = src.indexOf('{', t)
        if (bodyBrace !== -1) braceStart = bodyBrace
      }
    }
  }

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

// 抽出対象の定数（対象関数が参照するモジュールレベルの const）。
// 1行で完結する宣言だけを対象にする。関数だけを移すと gen 側で ReferenceError になる
// （実例: projParsePeriod は PROJ_MON、_cachedSkillRegex は _skillRegexCache を参照する）。
const TARGET_CONSTS = [
  'PROJ_MON',          // projParsePeriod が使う英語3文字月名
  '_skillRegexCache',  // _cachedSkillRegex のキャッシュ
  // extractSkillYearsVisualProject（案件ブロックunion）が参照する判定regex群
  'PROJ_TECHCOL',
  'PROJ_PERIODCOL',
  'KAKKO_TECH',
  'KAKKO_SKIP',
  'PROJ_JUNK',
  'PROJ_KEEP_WHOLE',
  'PROJ_PREFIX_RE',
]

/** `const NAME = ...` の1行宣言を取り出す */
function extractConst(src, name) {
  const re = new RegExp(`^const ${name.replace(/[$]/g, '\\$&')}\\b.*$`, 'm')
  const m = src.match(re)
  return m ? m[0] : null
}

// ── メイン ────────────────────────────────────────────────────────

const src = readFileSync(SRC, 'utf-8')

const extracted = []
const missing = []
const consts = []

for (const name of TARGET_CONSTS) {
  const line = extractConst(src, name)
  if (!line) { missing.push(`const ${name}`); continue }
  consts.push(stripTs(line))
}

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
  ...(consts.length ? [`// ── 対象関数が参照する定数 ──`, ...consts, ``] : []),
  ...extracted.map(({ name, js }) => `// ── ${name} ──\n${js}\n`),
  ``,
  `export {`,
  ...extracted.map(({ name }) => `  ${name},`),
  `}`,
].join('\n')

writeFileSync(DEST, output, 'utf-8')
console.log(`✅ _extractors.gen.mjs を生成しました（${extracted.length}関数）`)
if (missing.length > 0) console.log(`   未取得: ${missing.join(', ')}`)
