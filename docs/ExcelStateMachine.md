# Excel スキルシート解析 ステートマシン設計書

`spanCellsToJson` の設計仕様。SheetJS `!merges` の座標情報を主とし、2つの辞書を補助とする。

---

## 設計原則

**幾何優先・辞書は補助。**

状態遷移は rowSpan / colSpan の大小比較で決める。辞書は兄弟キー判定のみに使う。

---

## 状態一覧

```typescript
const enum Sm {
  START  = 0,  // キー探索開始
  KEY_H  = 1,  // キー確定。右へ走査
  KEY_V  = 2,  // キー確定。下へ走査
  END    = 3   // 処理完了
}
```

---

## 2辞書構成

| 辞書 | 名前 | 含む語 | 用途 |
|---|---|---|---|
| **A** | `STRUCTURE_KEY_DICT` | 構造キーのみ | 兄弟キー判定（構造） |
| **B** | `TAG_DICT` | 構造キー＋スキル深掘り語＋サブラベル | コンテナ判定、兄弟判定（スキル） |

**包含関係**: A ⊂ B

---

## 状態変数

| 変数 | 型 | 役割 |
|---|---|---|
| `record` | object | 大元の JSON |
| `currentRecord` | object | 現在の操作位置（コンテナで潜る） |
| `recordStack` | object[] | 親ポインタの履歴 |
| `smKey` | SpanCell | 現在のキーセル |
| `inSkillDeepDive` | boolean | スキル深掘り中か（START で確定） |

---

## START

次の SpanCell をキー候補として読む。

1. `inSkillDeepDive` をセット: `TAG_DICT.test(key) && !STRUCTURE_KEY_DICT.test(key)`
2. キーを record に追加: `currentRecord[key] = ""`
3. 右セルあれば KEY_H へ、なければ KEY_V へ

---

## KEY_H

**現在セル＝キー。右隣を確認する。**

| 条件 | 判定 | 動作 |
|---|---|---|
| **兄弟キー** | `_rs(right) === _rs(key)` かつ<br>`STRUCTURE_KEY_DICT.test(right)` または<br>`(inSkillDeepDive && TAG_DICT.test(right))` | KEY_V へ（右セルは次キー候補） |
| **コンテナ昇格** | `TAG_DICT.test(right)` かつ `_rs(right) < _rs(key)` | `recordStack.push(currentRecord)`<br>`currentRecord = currentRecord[key] = {}`<br>子ステートマシン実行<br>`currentRecord = recordStack.pop()`<br>→ START |
| **値確定** | その他（右セルあり） | `currentRecord[key] = right.value` または `[right.value, ...]`（複数行継続時は配列）<br>→ START |
| **下へ** | 右セルなし | KEY_V へ |

---

## KEY_V

**現在セル＝キー。下のセルを確認する。**

| 条件 | 判定 | 動作 |
|---|---|---|
| **兄弟キー** | `_cs(below) === _cs(key)` かつ<br>`TAG_DICT.test(below)` | KEY_V へ（下セルは次キー候補） |
| **コンテナ昇格** | `TAG_DICT.test(below)` かつ `_cs(below) < _cs(key)` | `recordStack.push(currentRecord)`<br>`currentRecord = currentRecord[key] = {}`<br>子ステートマシン実行<br>`currentRecord = recordStack.pop()`<br>→ START |
| **値確定** | その他（下セルあり） | `currentRecord[key] = below.value` または `[below.value, ...]`（複数行継続時は配列）<br>→ START |
| **完了** | 下セルなし | END |

---

## 値の複数行/複数列継続

KEY_H または KEY_V で値確定後、**同じ rowSpan/colSpan で隣接する非タグセル**は自動連結（値が複数なら配列化）。

**例1: 最寄駅（KEY_H で横継続）**
```
最寄駅(key, rs=1) → 宇都宮(rs=1) → [線(rs=1), 浦和(rs=1), 駅(rs=1)]
結果: currentRecord["最寄駅"] = ["宇都宮", "線", "浦和", "駅"]
```

**例2: スキル - 業務経験/知識有り（KEY_V で縦継続）**
```
コンピュータ言語(key, cs=6)
  ↓ 業務経験(cs=3), 知識有り(cs=3)  ← 兄弟キー（KEY_H）
    ↓ PHP/Python(cs=3), ShellScript(cs=3)
    ↓ 次行: 業務経験(cs=3), 知識有り(cs=3)
結果:
{
  "業務経験": ["PHP/Python", "..."],
  "知識有り": ["ShellScript", "..."]
}
```

---

## 入力データ

SheetJS `sheet_to_json({ header: 1 })` で全セル値を二次元配列で取得。  
`ws['!merges']` で結合セル情報を取得。

**SpanCell:**
```typescript
type SpanCell = {
  row:    number
  col:    number
  rowEnd: number
  colEnd: number
  value:  string
}
```

結合セルも非結合セルも同じ SpanCell に統一。

---

## 例: スキルセクション

```
スキル（左端ワイドキー）
  ↓ コンピュータ言語（KEY_V で下へ）
    ↓ 業務経験, 知識有り（KEY_H で右へ → 兄弟キー）
      ↓ PHP/Python/HTML/CSS/TypeScript
      ↓ ShellScript(bash) /SQL
  ↓ サーバOS
    ↓ 業務経験, 知識有り（KEY_H）
      ↓ Linux(CentOS)
      ↓ （空）
```

**結果:**
```json
{
  "スキル": {
    "コンピュータ言語": {
      "業務経験": "PHP/Python/HTML/CSS/TypeScript",
      "知識有り": "ShellScript(bash) /SQL"
    },
    "サーバOS": {
      "業務経験": "Linux(CentOS)",
      "知識有り": ""
    }
  }
}
```

---

## 重要な処理フロー

1. **START**: キーを見つけて `currentRecord[key] = ""`
2. **KEY_H/KEY_V**: 値確定またはコンテナ昇格
3. **コンテナ昇格時**: スタック保存 → 階層下げ → 子処理 → スタック復帰 → START
4. **終了**: スキャン対象セル枯渇 → END
