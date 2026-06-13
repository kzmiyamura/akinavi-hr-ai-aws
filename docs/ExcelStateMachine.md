# Excel スキルシート解析 ステートマシン設計書

`spanCellsToJson` の完全再設計仕様。SheetJS `!merges` の座標情報のみを使った純粋な幾何判定により、ラベル依存・っぽい判定を完全に排除する。

---

## 前提：ハイブリッドスコア関数

全ての CONTAINER 判定はこの関数を経由する。純粋な Span 比較には依存しない。

```typescript
function isContainer(cell: SpanCell, currentKey: SpanCell): boolean {
  let score = 0
  if (cell.rowSpan > currentKey.rowSpan)   score += 1   // 幾何：縦に大きい
  if (cell.colSpan > 2)                    score += 1   // 幾何：横に広い
  if (cell.col === 0 || cell.col === 1)    score += 1   // 位置：左端付近
  if (MATCHES_COL_HEADER_DICT(cell.value)) score += 2   // 辞書：列ヘッダー語彙
  return score >= 2   // 閾値は実装時にテストで調整する
}
```

**使わないもの（却下済み）：**
- `cell.value.length > 50`：っぽい判定のため却下
- `MATCHES_KNOWN_CONTAINER_REGEX`：ラベル列挙に戻るため却下

---

## 入力データの構造

SheetJS `sheet_to_json({ header: 1 })` で全セル値を二次元配列で取得。  
`ws['!merges']` で結合セル情報を取得。形式は `{ s: { r, c }, e: { r, c } }`。

これを **SpanCell** のリストに変換する：

```typescript
type SpanCell = {
  row:    number   // 左上セルの行インデックス
  col:    number   // 左上セルの列インデックス
  rowEnd: number   // 右下セルの行インデックス（結合なし = row と同じ）
  colEnd: number   // 右下セルの列インデックス（結合なし = col と同じ）
  value:  string   // セルの値
}
```

結合されていない単独セルも `rowEnd = row, colEnd = col` として SpanCell に統一する。

---

## 状態一覧

| 状態 | 意味 |
|---|---|
| `KEY_H` | 現在セルをキーとして確定。横方向（右）にバリューを探す |
| `KEY_V` | 現在セルをキーとして確定。縦方向（下）にバリューを探す |
| `READ_COL_HEADERS` | マトリクス表の列ヘッダー行をキャッシュする |
| `CONTAINER` | 現在セルをコンテナとして確定。内部を再帰スキャンする |
| `KV_DONE` | キーバリューペアが確定した。次のキーを探す |
| `NEW_ROW` | 横方向スキャンが終わった。次の行の走査開始位置に戻る |
| `END` | 全SpanCellを処理し終えた |

---

## 開始

最初のSpanCellをキーとして読む。右隣にセルがあれば **KEY_H** へ。なければ下を確認して **KEY_V** へ。

---

## KEY_H

**「現在セル＝キー。右隣のSpanCellを確認する。」**

右隣のSpanCellを取得し、上から順に評価する。

| 条件 | 遷移先 | 意味 |
|---|---|---|
| 右セルが存在する かつ `isContainer(右セル, キー) === true` | **CONTAINER** | 右セルはコンテナ構造である |
| 右セルが存在する かつ `isContainer === false` かつ 右セル.rowSpan **==** キー.rowSpan | **KV_DONE** | 縦幅が同じ。右セルはこのキーのバリューである |
| 右セルが存在する かつ `isContainer === false` かつ 右セル.rowSpan **<** キー.rowSpan かつ `MATCHES_COL_HEADER_DICT(右セル.value) === true` | **READ_COL_HEADERS** | 縦に小さく、かつ辞書にある列ヘッダー語彙。マトリクス列ヘッダー行が始まる |
| 右セルが存在する かつ `isContainer === false` かつ 右セル.rowSpan **<** キー.rowSpan かつ `MATCHES_COL_HEADER_DICT(右セル.value) === false` | **CONTAINER** | 縦に小さいが辞書にない。通常の子コンテナとして扱う |
| 右にセルなし | **NEW_ROW** | この行のスキャンが終わった |

---

## KEY_V

**「現在セル＝キー。真下のSpanCellを確認する。」**

真下のSpanCellを取得し、上から順に評価する。

| 条件 | 遷移先 | 意味 |
|---|---|---|
| 下セルが存在する かつ `isContainer(下セル, キー) === true` | **CONTAINER** | 下セルはネストされたコンテナ構造である |
| 下セルが存在する かつ `isContainer === false` かつ 下セル.colSpan **==** キー.colSpan | **KV_DONE** | 横幅が同じ。下セルはこのキーのバリューである |
| 下セルが存在する かつ `isContainer === false` かつ 下セル.colSpan **<** キー.colSpan | **CONTAINER** | 下セルが横に小さい。現在のキー自体がコンテナであり、下セル群は子である |
| 下にセルなし | **END** | スキャン終了 |

---

## READ_COL_HEADERS

**「現在行の残りセルを全て列ヘッダーとしてキャッシュする。」**

現在行を左から右へスキャンし、各セルの `(col番号, 値)` を `colHeaderMap: Map<col番号, 文字列>` に格納する。

| 条件 | 遷移先 |
|---|---|
| 行末に達した | **NEW_ROW** |

以降の行では、各セルの値を `colHeaderMap[そのセルのcol番号]` の文字列をキーとして `{ 列ヘッダー: セル値 }` のペアを生成する。

サイズ関係が変化した（マトリクスの終端に達した）タイミングで `colHeaderMap` をクリアする。

---

## CONTAINER

**「現在セルをコンテナとして確定。内部の子SpanCellを再帰スキャンする。」**

1. 現在セルの座標 `{ row, col, rowEnd, colEnd }` の範囲内に含まれる全SpanCellを抽出する。
2. 抽出した子SpanCellリストに対して、ステートマシンを最初から再帰実行する。
3. 再帰の結果として得られた `{ key: value }` ペアの集合を、このコンテナキーのバリューとして格納する。
4. → **NEW_ROW** へ遷移する（コンテナ内部の処理が完了した。次の親レベルの要素を探す）

---

## KV_DONE

**「キーバリューペアが確定した。右方向に次のキーを探す。」**

右方向に次のSpanCellを確認する。

| 条件 | 遷移先 | 意味 |
|---|---|---|
| 次セルのサイズ関係が直前キーと**同じ** | **KEY_H**（次セルを新しいキーとして続ける） | 同レベルのキーが横に続いている |
| 次セルのサイズ関係が**変化した** | 現在レベル終了 → **親コンテキストへ戻る** | このレベルのスキャンが終わった |
| 右にセルがなくなった | **NEW_ROW** | 行末に達した |

---

## NEW_ROW

**「横方向スキャン終了。次の行の走査開始位置を決めて移動する。」**

走査開始位置の決定：

| 条件 | 走査開始位置 |
|---|---|
| 現在のコンテナコンテキストがある | そのコンテナの `col` 位置（col=0 には戻らない） |
| コンテキストがない | `col = 0` |

移動後の処理：

| 条件 | 遷移先 |
|---|---|
| 次の行にSpanCellがある | **KEY_H** |
| 次の行にSpanCellがない | **END** |

---

## END

全SpanCellの処理完了。収集した全 `{ key: value }` ペアを返す。

---

## 採用・却下シグナル一覧

| シグナル | 種別 | 採否 | 理由 |
|---|---|---|---|
| `cell.rowSpan > currentKey.rowSpan` | 幾何 | **採用** | 座標比較 |
| `cell.colSpan > 2` | 幾何 | **採用** | 座標比較 |
| `cell.col === 0 または 1` | 位置 | **採用** | 幾何的位置情報 |
| `MATCHES_COL_HEADER_DICT(cell.value)` | 辞書 | **採用（限定）** | READ_COL_HEADERS 判定とスコア加算のみ |
| `cell.value.length > 50` | ヒューリスティック | **却下** | っぽい判定 |
| `MATCHES_KNOWN_CONTAINER_REGEX` | ラベル列挙 | **却下** | ラベル全網羅問題に戻る |
| スコアリングによる確率的判定 | スコア | **却下** | 決定論的遷移を維持するため |
