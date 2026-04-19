# epub-deco

InDesignで作成した日本語縦書きのEPubを整形するスクリプトです。

主にできること:

- InDesign出力EPubの問題修正
  - アンカーオブジェクトにできない全画面の挿絵を適切な位置に再配置
  - 字下げの調整
    - ただしKindleではKindle側の仕様により逆にアキが足りなくなります。他のリーダーと共通で最適化する方法が分からないため仕様としています。
  - その他不要、不適切なCSSの排除
- 本文末尾/先頭に画像ページ（1画像 = 1ページ）を挿入（本体表紙、口絵、カバー画像など）

Android版Kindle、BOOK WALKERとWindows版Thoriumで動作確認を行っています。
お気付きの点があればIssueから報告してください。

## 動作環境

- Windows 10/11（Linux でも動作します）
- コマンドプロンプトまたは PowerShell を触れること
- 本ツールが利用する外部プログラム:
  - **Bun**（TypeScript を実行するランタイム）
  - **ImageMagick**（画像のリサイズに使用）

## 事前準備

### 1. Bun のインストール

PowerShell を開き、以下を実行します（管理者権限不要）:

```
powershell -c "irm bun.com/install.ps1 | iex"
```

インストール後、一度 PowerShell を開き直してから次を実行し、バージョンが表示されれば OK です。

```
bun --version
```

### 2. ImageMagick のインストール

追加画像の解像度調整に利用します。
あらかじめWeb配布用の解像度の画像を準備している場合はスキップできます。
公式サイトから Windows 用のインストーラを入手するのが最も確実です。

- ダウンロード: <https://imagemagick.org/script/download.php#windows>
- インストーラ名の例: `ImageMagick-7.x.x-Q16-HDRI-x64-dll.exe`
- インストール時は既定のまま「Next」で進めて問題ありません。
- Microsoft Store 版の ImageMagick（`%LOCALAPPDATA%\Microsoft\WindowsApps\magick.exe`）を使う場合、 **magick が起動できないとき** を参照してください。

インストール後、PowerShell を開き直して以下を実行し、バージョンが表示されれば OK です。

```
magick -version
```

### 3. 本ツール本体の取得

このフォルダ（`epub-deco`）一式を任意の場所に置きます。以後、このフォルダを「本ツールフォルダ」と呼びます。

PowerShell で本ツールフォルダに移動し、依存ライブラリを取得します。

```
cd <本ツールフォルダのパス>
bun install
```

## 使い方

### 0. InDesign側の書き出し設定

InDesignは「書き出し」で「EPUB（リフロー可能）」を選ぶと書き出しオプションが選べます。
文書作成時に以下の準備をしておいてください。

- 本文に自動字下げを使う段落スタイルを設定している（スペースをベタ打ちしていない）。
  自動字下げしていない場合には現状対応していません（固定でtext-indentを挿入します）。
  不要な場合はそこの処理を消してください (`css.ts` の `appendIndentParagraphRule`)
- 全ページになる挿絵にオブジェクトスタイルを設定している。
  InDesignで文中に図表を挿入する場合アンカーオブジェクトを使うことが推奨されますが、アンカーオブジェクトは原則としてテキストの周辺（文中または上下左右）にしか配置できません。
  文庫ライトノベルの挿絵のような全ページ裁ち落としありの画像を挿入しようと思うと、独立ページを作成し、スプレッドも分けて画像を配置することが一般的です。
  この場合アンカーをつけられなくなりますので、挿絵がEPUBの最後にまとめて並んでしまいます。
  この状態を解消するため、最後に団子になっている画像を、ページ数が飛んでいる箇所を特定して再配置しています。
  オブジェクトスタイルはアンカーオブジェクトでない挿絵を検出するためのマーカーなので、設定や名称はなんでもかまいません。

### 1. 加工用フォルダを作る

加工したい EPUB と、挿入したい画像を置くためのフォルダを作ります（本ツールフォルダ内である必要はありません）。例:

```
C:\work\my-epub\
  ├─ source.epub         （加工したい元 EPUB）
  ├─ cover-extra-01.jpg  （本文先頭側に入れたい画像）
  ├─ cover-extra-02.jpg
  ├─ afterword-01.jpg    （本文末尾側に入れたい画像）
  └─ config.json         （これから作る設定ファイル）
```

### 2. 設定ファイル `config.json` を書く

同じフォルダに `config.json` を作ります。内容はシンプルな JSON です。テキストエディタ（メモ帳でも可）で作成してください。

最小構成の例:

```json
{
  "epub": "source.epub",
  "pre": ["cover-extra-01.jpg", "cover-extra-02.jpg"],
  "post": ["afterword-01.jpg"],
  "resize": 1920000,
  "quality": 85,
  "indentClassName": "本文-自動字下げ",
  "imageClassName": "全画面挿絵"
}
```

各項目の意味:

| キー | 必須 | 説明 |
| --- | --- | --- |
| `epub` | 必須 | 加工対象の EPUB ファイル名（`config.json` から見た相対パス）。 |
| `pre` | 任意 | 本文の**前**に挿入する画像のリスト。上から順に入ります。 |
| `post` | 任意 | 本文の**後**に挿入する画像のリスト。上から順に入ります。 |
| `resize` | 任意 | 追加画像をリサイズしたい場合は、画像の目標**総ピクセル数**（幅×高さ）。例 `1920000` は約 1600×1200 相当。縦横比は保たれます。 |
| `quality` | 必須 | JPEG 等の画質（1〜100、目安 80〜90）。 |
| `indentSkipChars` | 任意 | 字下げを無効化する対象の先頭文字を上書き。例: `"「『？！"`。既定値は `「『〈《【〔（(？！・`。 |
| `indentClassName` | 任意 | 字下げ無効化の対象とする `<p>` のクラス名。既定値は `本文-自動字下げ`。 |
| `imageClassName` | 任意 | 画像自動再配置の対象とする `<div>` のクラス名。既定値は `全画面挿絵`。 |
| `magick` | 任意 | ImageMagick の `magick` の**絶対パス**。通常は不要（PATH から自動発見）。 |

ファイル参照（`epub`・`pre`・`post`）は `config.json` と同じフォルダからの相対パスです。

#### 表紙の扱い

EPUB に「表紙（cover-image）」の指定が含まれている場合、`pre` の画像は**表紙の直後**に入ります（表紙より前には入りません）。表紙指定が無い場合は本文の先頭に入ります。表紙そのものは変更しません。

### 3. 実行

PowerShell で本ツールフォルダに移動し、以下を実行します。

```
cd <本ツールフォルダのパス>
bun run index.ts "C:\work\my-epub\config.json"
```

成功すると、`config.json` と同じフォルダに `source-concat.epub` が作られます。

画面には以下のような進捗と結果が表示されます:

```
[info] tmp dir: ...
[info] loading: C:\work\my-epub\source.epub
[info] opf: OEBPS/content.opf
[info] cover page detected: OEBPS/Text/cover.xhtml
[info] css: removed "color: #231815" declarations
[info] relocate: 画像 #1 を page29 に挿入 (file=OEBPS/Text/body.xhtml)
[info] relocate: 画像 #2 を page62 に挿入 (file=OEBPS/Text/body.xhtml)
[info] indent: updated 128 paragraphs
[info] resize: pre-01.jpg
[info] resize: post-01.jpg
[info] building output zip
[info] wrote: C:\work\my-epub\source-concat.epub
[info] --- metadata ---
[info]   <dc:title>...</dc:title>
[info]   ...
[info] added files: 6
[info] output size: 12.34 MB (12,942,336 bytes)
[info] 画像再配置の結果:
[info]   xhtml                   | 移動件数 | 配置先ページ
[info]   ------------------------+----------+-------------
[info]   OEBPS/Text/body.xhtml   |        2 | 29, 62
[info]   ------------------------+----------+-------------
[info]   合計                    |        2 |
```

## トラブル対処

手元の小説原稿でのみ試しているため、対応漏れが予想されます。
問題や不便あればお気軽にIssueから報告ください。

### `[error] usage: bun run index.ts <config.json>`

引数に設定ファイルのパスを渡していません。`bun run index.ts "<config.jsonのフルパス>"` の形で指定してください。

### `[error] missing: ...`

指定された EPUB や画像が見つかりません。`config.json` と同じフォルダに実在しているか、ファイル名のスペルやスペース・全角半角を確認してください。パスはダブルクォートで囲むと安全です。

### `[error] missing: magick (not on PATH)`

ImageMagick がインストールされていない、または PATH が通っていません。PowerShell を開き直してから `magick -version` が動くか確認してください。

### `[error] missing: magick (path not runnable: ...)` （magick が起動できないとき）

特に Microsoft Store 版の ImageMagick を入れているときに発生します。`C:\Users\<あなた>\AppData\Local\Microsoft\WindowsApps\magick.exe` は見かけ上あるように見えますが、Bun からは直接起動できません。

対処法のおすすめ順:

1. 公式インストーラ版の ImageMagick を入れ直す（上の「事前準備 2.」）。`C:\Program Files\ImageMagick-7.x.x-Q16-HDRI\magick.exe` のようなパスに入り、問題なく動きます。
2. どうしても Store 版を使いたい場合は、実体パスを `config.json` の `magick` に絶対パスで指定します。例:

   ```json
   {
     "magick": "C:\\Program Files\\WindowsApps\\ImageMagick.Q16-HDRI_7.1.2.7_x64__b3hnabsze9y3j\\magick.exe"
   }
   ```

   （バージョン番号の部分はアップデートごとに変わるので、変わったら設定を更新してください。）

### `[error] ...: tail 画像数 N と候補ギャップ数 M が一致しません`

画像自動再配置の件数検証エラーです。本ツールは InDesign 出力の典型パターン（本文末尾に `<div class="全画面挿絵">` がまとめて出力され、doc-pagebreak でページ番号が欠落している状態）を前提に、欠落ページへ自動的に差し戻します。検出されたページ番号の欠落数と、再配置対象として認識した画像数が食い違うと本エラーになります。

対処:

- 元 EPUB の本文 xhtml を開き、`<div class="基本グリッド ...">` の直後にぶら下がっている `<div class="全画面挿絵">` の個数と、`aria-label` の欠番の個数が一致しているか確認してください。
- 使っているクラス名が異なる場合は `imageClassName` で上書きできます。
- そもそも再配置が不要な EPUB の場合、該当箇所のレイアウトが本ツールの想定と違う可能性があります。

## License

MIT License.
