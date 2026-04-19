# epubを加工する

指定されたJSON設定ファイルを読み込み、対象のepubの本文を加工し、前後に画像ページを追加して別ファイル（`<元ファイル名>-concat.epub`）として保存する。

## 入力と実行方法

### CLIインターフェース

```
bun run index.ts <config.json>
```

- 引数は設定JSONのパス1つだけ。すべての設定はJSON側で行う。
- `<config.json>` と同じディレクトリに出力ファイルを置く（常に上書き）。

### 設定JSONの形式

オブジェクト形式。ファイル参照はJSONからの相対パス。

```json
{
  "epub": "main.epub",
  "pre": ["p1.jpg", "p2.jpg"],
  "post": ["end.jpg"],
  "resize": 1920000,
  "quality": 85,
  "indentSkipChars": "「『？！・（"
}
```

- `epub`: 加工対象のepubファイル（必須）。
- `pre`: 本文先頭側に追加する画像リスト（任意、デフォルトは空）。
- `post`: 本文末尾側に追加する画像リスト（任意、デフォルトは空）。
- `resize`: `magick mogrify -resize` に渡す**総ピクセル数（数値）**。末尾に `@` を自動付与（例: `1920000` → `-resize 1920000@`）。
- `quality`: JPEG等の品質（整数、例 `85`）。
- `indentSkipChars`: 字下げ無効化の対象先頭文字リストを上書きする場合に使用（任意）。未指定時は下記デフォルトを使用。
- `indentClassName`: 字下げ無効化対象とする `<p>` のクラス名（任意）。未指定時は `本文-自動字下げ`。
- `imageClassName`: 画像自動再配置の対象とする `<div>` のクラス名（任意）。未指定時は `全画面挿絵`。
- `magick`: `magick` 実行ファイルの**絶対パス**（任意）。未指定時は PATH 上の `magick` → `magick.exe` の順で探索。

### 入力の事前検査

処理開始前に全参照ファイル（epub、pre, postの各画像）の存在を一括検査し、1つでも欠けていれば全件列挙してエラー終了する（処理開始後に欠落で中断しない）。

## 出力

- 出力ファイル名: `<元epubファイル名>-concat.epub`
- 出力先: **JSONと同じディレクトリ**
- 同名ファイルが既に存在しても常に上書き
- 書き込みは**アトミックリネーム**: 一時ファイルに完全出力してから目的ファイルにリネーム。途中失敗時に不完全ファイルが残らない。

## 加工処理

### 1. CSSの色指定削除

対象: `OEBPS/css/idGeneratedStyles.css`

- `color: #231815` を含むCSS宣言を削除する。
- **プロパティ名としての `color` のみ**を対象にする。`border-color` / `outline-color` / `text-decoration-color` など、ハイフンを含む複合プロパティは**破損させない**（`color` の直前に英数字・ハイフンが無いことを条件にする）。
- 粒度: 該当宣言（`color: #231815;`）のみを削除する。同一行に他宣言があれば他宣言は残す。宣言単独行なら空行ごと削除してよい。
- 該当CSSファイルが存在しない場合は**警告を出してスキップ**し、他の加工は続行する。

### 2. 画像の自動再配置

InDesign から出力した xhtml では、`<div class="全画面挿絵">`（クラス名は `imageClassName` で上書き可）が本来のページ位置ではなく、`<div class="基本グリッド ...">` の直後に**ぶら下がって**まとめて配置されることがある。これを `doc-pagebreak` の欠落ページ位置に再配置する。

対象 xhtml: `content.opf` の `<spine>` に含まれる全 xhtml を、**ファイルごとに独立に**処理する。

#### 2.1 要素の認識

- **ページブレーク要素**: `role="doc-pagebreak"` または `epub:type="pagebreak"` を持つ `<div>`・`<span>`。`aria-label` は整数にパースできる必要がある。
- **基本グリッド要素**: `class` 属性に `基本グリッド` を含む `<div>`。
- **画像要素**: `class` 属性に `imageClassName`（既定: `全画面挿絵`）を含む `<div>`。
- **目次要素**: `epub:type="toc"` を持つ最初の要素。

#### 2.2 移動対象（tail）の特定

各**基本グリッド**要素 B について、B の**兄弟ノード**を document 順に前方へ走査する:

- 兄弟が `<div>` で、**直接の子**に**画像要素**（`<div class="全画面挿絵">`）を含む → **dangling wrapper** として収集。
- 条件を満たさない要素が現れた時点で走査を打ち切る（以降は別の塊とみなす）。

収集された wrapper 群が tail である。**移動するのは wrapper 自身**（= 画像要素の親 `<div>` 全体）であり、内側の画像要素だけを取り出すわけではない。

tail wrapper に含まれない画像要素は **in-body** として位置を保持する。

#### 2.3 ページブレークの検証

- `aria-label` が整数でない要素が存在する → **エラー中断**。
- document 順で `aria-label` が逆転・重複する → **エラー中断**。

#### 2.4 ギャップ候補の列挙

- ページブレーク列 P を document 順に見て、隣接する `pb_i`, `pb_{i+1}` の `label` 差が 2 以上なら、その間の欠落ページ番号を列挙する。
- **目次フィルタ**: 目次要素が存在する場合、その要素より document 順で**後**にある最初のページブレークのラベルを `L_toc` とする。候補ページのうち **`page < L_toc` を満たすもの**（＝目次および前付けのページ）は**捨てる**。
- **in-body 補正**: 区間 `(pb_i, pb_{i+1})` の内部にある in-body 画像要素の数 `k` に応じて、その区間の欠落ページのうち**低い方から順に `k` 個**を埋まっているとみなして候補から除外する。
- 残った候補ページを昇順に並べたものを `G` とする。

#### 2.5 件数検証

- `length(tailWrappers) === length(G)` でなければ **エラー中断**。エラーメッセージに xhtml ファイル名・tail 画像数・候補ギャップ一覧を列挙する。

#### 2.6 挿入

tail wrapper を出現順、`G` を昇順で 1:1 に割り当てる:

- 欠落ページ `g_k` の**直後**に来るページブレーク要素 `pb_next`（= `label >= g_k + 1` を満たす最初の pb）を求める。
- **挿入位置**:
  - `pb_next` が `<div ... role="doc-pagebreak" .../>` のとき → その `<div>` の**直前**。
  - `pb_next` が `<span ... role="doc-pagebreak" ...>` のとき → span の**祖先を document 上に遡って最初に現れるブロックレベル要素**（`<p>` のみを想定）の直前。
  - span の祖先が `<p>` でない（例: `<li>`, `<h1>`, `<div>` 直下）場合は **エラー中断**。
- 移動は wrapper の**ソース文字列をそのまま切り出して挿入位置に差し込む**実装方針とし、属性順・改行・空要素表記は維持する。
- `id` 属性は wrapper・子要素いずれも保持する（同一 xhtml 内の移動なので fragment 参照は壊れない）。

#### 2.7 ログ出力

- 移動が発生するたびに 1 行の `[info]` ログを出力:
  ```
  [info] relocate: 画像 #<idx> を page<page> に挿入 (file=<xhtml>)
  ```
- 全 spine xhtml を処理し終えた後、**終了時サマリ**として xhtml ごとの移動件数・配置先ページを表形式で出力。移動 0 件の xhtml は行に含めない。1 件も発生しなければ `[info] 画像再配置: 対象なし` の 1 行のみ。

#### 2.8 異常系／スキップ条件

| 条件 | 振る舞い |
| --- | --- |
| `aria-label` が整数にパースできない | **exit 1** |
| document 順で `aria-label` が逆転・重複 | **exit 1** |
| tail wrapper 数 ≠ 候補ギャップ数 | **exit 1** |
| span 型 pb の祖先に `<p>` が無い | **exit 1** |
| ページブレーク 0 件 | 何もせず次の xhtml へ |
| 画像要素が xhtml 内に 0 件 | 何もせず次の xhtml へ |
| tail wrapper 0 件かつ候補ギャップ 0 件 | 正常。何もせず次の xhtml へ |

エラー発生時は、画像再配置の途中結果を含め §3 以降の加工を**一切実行せず**、一時ファイル・出力先への書き込みを行わないまま `exit 1` する。

### 3. 字下げの無効化

対象xhtml: `content.opf` の `<spine>` に含まれる全xhtmlファイル。

条件:

- `<p>` タグの `class` 属性に（空白区切りの複数クラスのうち1つでも）`本文-自動字下げ` を含む。
- かつ、段落テキストの**最初の実文字**（先頭の空白・ルビ・`<span>` などのタグは飛ばした後の1文字目）が以下のいずれかで始まる。

対象先頭文字（デフォルト）:

```
「『〈《【〔（(？！・
```

仕様の6文字（`「『？！・（`）＋主要な日本語開き括弧を含む。`indentSkipChars` オプションで上書き可能。

処理:

- `<p>` タグに `style="text-indent: 0;"` を反映する。
- 既に `style` 属性がある場合:
  - `text-indent` が既にあれば**何もしない**（ドキュメントを優先）。
  - `text-indent` がなければ `;text-indent: 0;` を**追記**。

### 4. 画像ページの追加

各画像を「1画像=1ページ」で埋め込む。

#### 画像ファイル配置

- 格納先: `OEBPS/image/`
- ファイル名は**入力の拡張子を保持**（`.jpg` は `.jpg` のまま）。
- 既存ファイルと名前が衝突する場合は自動でプレフィクスを付けて回避する。

#### リサイズ

元画像を破壊しないよう一時ディレクトリに画像をコピーしてから処理する。

```
magick mogrify -resize <resize>@ -quality <quality> <file>
```

- `magick` の解決: 設定の `magick` フィールドが**絶対パス**で指定されていればそれを使用。未指定時は PATH 上から `magick` → `magick.exe` の順で探索。いずれも実行できなければエラー終了。
  - 備考: Windows の App Execution Alias（`%LOCALAPPDATA%\Microsoft\WindowsApps\magick.exe` などのリパースポイント）は Bun/libuv の `spawn` からは ENOENT で失敗する。その場合は `C:\Program Files\WindowsApps\ImageMagick...\magick.exe` のような**実体パス**を `magick` に指定する。
- 一時ディレクトリは **OSの標準tmp（`os.tmpdir()`）配下にユニークなサブディレクトリ**を作成し、実行終了時に自動削除する。

#### ページ化（xhtmlラッパー + SVG fit）

1画像につきxhtmlを1つ生成し、SVGで `viewBox` 指定することでリーダー側のサイズ差を吸収し、フルページ表示にする。

ラッパーxhtmlのファイル名:

- 前置画像: `pre-01.xhtml`, `pre-02.xhtml`, ...
- 後置画像: `post-01.xhtml`, `post-02.xhtml`, ...
- 既存xhtmlと衝突した場合はプレフィクスをずらして回避。

SVGテンプレート例:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <meta charset="UTF-8"/>
  <title>...</title>
  <style>html,body{margin:0;padding:0;height:100%}svg{display:block;width:100%;height:100%}</style>
</head>
<body>
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
       version="1.1" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet">
    <image width="{W}" height="{H}" preserveAspectRatio="xMidYMid meet" xlink:href="{IMG_HREF}"/>
  </svg>
</body>
</html>
```

`{W}`/`{H}` はリサイズ後の実寸。`{IMG_HREF}` は**xhtml の配置ディレクトリから画像ファイル（`OEBPS/image/...`）への相対パス**を算出して埋める（xhtml が `OEBPS/` 直下なら `image/post-01.jpg`、`OEBPS/Text/` 配下なら `../image/post-01.jpg` など）。xhtml の配置ディレクトリは既存 spine xhtml と同じディレクトリ。

`preserveAspectRatio` は外側 `<svg>` と内側 `<image>` の**両方**に付ける。外側だけだと `<image>` 要素を独立に伸縮させる実装のリーダー（旧 Kindle、一部の iOS 系ビューア）で縦横比が崩れるため。

#### OPF反映

- `manifest`: 新規画像ファイルと新規xhtmlを追加（適切な `media-type`、xhtmlのitemに `properties="svg"` を付ける）。
- `spine`: 挿入順序は以下。
  - `cover` (properties="cover-image" の画像を参照する最初のページ) が既存にあれば、**cover の直後**に `pre` を順に挿入。
  - `cover` がなければ spine の先頭に `pre` を挿入。
  - 本文はそのまま。
  - spine 末尾に `post` を順に追加。
- `nav.xhtml` / `toc.ncx` (目次) は**変更しない**。
- 既存の `cover-image` 指定は**変更しない**（前置画像が新たな表紙になることはない）。

### 5. メタデータ更新

`content.opf` の以下を更新:

- `<meta property="dcterms:modified">` を現在のUTC時刻（`YYYY-MM-DDTHH:MM:SSZ`）に更新。未存在なら追加（EPUB3必須）。

その他（`dc:date`, `dc:identifier`, `dc:title`, 独自meta等）は変更しない。
最後に処理結果を表示する。表示するのは

- content.opf内の `metadata` の全項目
- 追加したファイル数
- 最終的なepubファイルサイズ（人間可読な単位 `B`/`KB`/`MB`/`GB`/`TB` ＋ 括弧内に正確なバイト数を併記）


## ZIP処理の規則

EPUB規格に準拠したzipを生成する:

- **`mimetype` エントリを最初に配置し、STORED（非圧縮）で格納**。extra fieldは付けない。
- 他のエントリは DEFLATE で圧縮して構わない。
- ディレクトリエントリは変更しない。

## 処理順序

1. JSON読込。
2. 全入力ファイル（epub, pre/post画像, magick存在）の一括検査。欠落があれば全件列挙してエラー終了。
3. OSのtmpにユニークサブディレクトリを作成。
4. epub(zip)をメモリに読み込み、必要なxml/xhtml/cssを解析。
5. 画像を一時ディレクトリにコピーし、magickでリサイズ。リサイズ後の実寸を取得。
6. CSS加工（§1）。存在しなければ警告のみ。
7. spine 内の全 xhtml について、画像の自動再配置（§2）→ 字下げ加工（§3）を 1 ファイルずつ続けて適用。
8. 画像ラッパーxhtml生成 + OPF manifest/spine 更新（§4）。
9. メタデータ更新（§5）。
10. epub(zip)を一時ファイルに書き出し。
11. 出力先にアトミックリネーム。
12. 一時ディレクトリを削除。
13. 終了時サマリの表示（§2.7 の表を含む）。

## 実装方針

- **TypeScript + Bun**。
- **Windows優先、Linuxでも動作すること**。パス操作は `path.posix` と `path` を意識して使い分ける（zip内部はフォワードスラッシュ、ファイルシステム側はOS依存）。
- zip操作は適切なライブラリを利用（例: `jszip` 等）。mimetypeを先頭にSTOREDで出力できる制御性があるものを選ぶ。
- xml解析は DOM 系（例: `fast-xml-parser`, `linkedom`）。元のフォーマット（インデント、属性順、XML宣言）をできるだけ保持する。
- 画像変換は `magick` 外部プロセス。子プロセス実行は `Bun.spawn` を使用。

## ログ出力

シンプルなテキスト出力。`[info] ...` / `[warn] ...` / `[error] ...` の1行プレフィクスでstdout/stderrに出す。

## エラーハンドリング方針

- 入力ファイル欠落: 全件検査後にまとめてエラー終了（exit 1）。
- CSS未検出: 警告のみ、処理続行。
- magick未検出/失敗: エラー終了（exit 1）。
- spineが見つからない/xhtmlパース失敗: エラー終了。
- 出力リネーム失敗: エラー終了し、一時ファイルは残さない。
