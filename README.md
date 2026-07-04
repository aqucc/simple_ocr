# ラベルOCR（ブラウザ完結・単一HTML）

家電などの製品ラベル（型番・製造番号のシール）をスマホで撮影し、**WebAssembly でブラウザ内ローカルOCR**（PaddleOCR PP-OCRv4 / Tesseract.js）して文字を抽出・編集し、写真とテキストを **IndexedDB** に保存する PoC アプリです。サーバーへ画像を送信しません。すべて 1 つの `index.html` で動作します。

- UI は日本語。iPhone SE3 の Safari と、デスクトップの主要ブラウザで動作します。
- 保存した記録は**保存日でグループ化**して一覧表示し、**月カレンダー**で日付を絞り込めます。

## これは何か / 主な機能

- **画像の入力（3通り）**
  - 「カメラで撮影」: `<input type="file" accept="image/*" capture="environment">`
  - 「画像を選択」: 端末内の画像ファイルを選択
  - 「クリップボードから貼り付け」: `navigator.clipboard.read()`。未対応・拒否時は日本語エラーを表示。ページ上で `Ctrl/Cmd+V`（paste イベント）にも対応。
- **読み取り範囲の指定（切り抜きGUI）**: 画像読み込み後、写真の上で枠をドラッグ（移動・四隅ハンドルでリサイズ、タッチ/マウス両対応）して読み取り範囲を指定できます。「この範囲を読み取る」「全体を読み取る」「やり直す」、結果画面からは「範囲を選び直す」が使えます。**読みたい行だけを枠で囲むのが精度向上の最重要ポイント**です。
- **エンジンの使い分け（自動）**:

  | モード × 経路 | エンジン |
  | --- | --- |
  | 英数字(型番向け) × 範囲指定 | **PaddleOCR PP-OCRv4**（認識モデル直当て・高精度、失敗時は Tesseract に自動フォールバック） |
  | 英数字(型番向け) × 全体 | Tesseract `eng` |
  | 日本語+英数字（範囲指定/全体） | Tesseract `jpn` |

  PaddleOCR 経路は「人間の範囲指定＝文字検出」とみなし、検出モデル（DBNet）を省いて**認識モデルのみ**を実行します。範囲内が複数行の場合は水平射影プロファイルで行分割して1行ずつ認識します。PP-OCRv4 の辞書は中国語+ASCII のため英数字の型番に適しています。
- **前処理（canvas）**: PaddleOCR にはカラーのまま（PP-OCR 系は非二値化入力が前提）。Tesseract には、範囲指定時は「拡大（短辺300px未満は2〜3倍）→ グレースケール → コントラスト伸長 → **Otsu 二値化（白黒反転の自動検出付き）**」、行数に応じて PSM 7（単一行）/ 6 を自動選択し、英数字モードでは文字ホワイトリストも設定。全体読み取り時は従来どおり縮小＋コントラスト伸長。
- **認識モード（撮影画面・撮影ボタンの上）**: 2つのセグメントボタンから選択でき、選択は `localStorage` に保存され次回起動時も復元されます。
  - 「英数字(型番向け)」（既定）: 範囲指定で PaddleOCR、初回のみエンジン+モデル（合計約22MB: ONNX Runtime WASM 約11.0MB + 認識モデル約10.8MB）をダウンロードします。
  - 「日本語+英数字」: Tesseract 言語 `jpn`。`jpn` の学習データは英数字も認識できるため、和文と型番が混在するラベルにはこちらを使用します（`eng` と `jpn` は別々の npm パッケージとして配布されており、1つの `langPath` から両方を取得できないため `jpn+eng` ではなく `jpn` 単体を使用）。初回切替時は日本語の学習データ（gzip 約2.0MB）を追加ダウンロードするため時間がかかる旨のヒントを表示します。
- **OCR（進捗表示）**: 進捗バーとステータス（例: 認識中…）を表示。Tesseract ワーカーは常に**最大1つだけ**保持し、モード切替後に次の OCR を実行するタイミングで前のワーカーを `terminate()` してから新しいワーカーを作成します（iPhone のメモリ対策）。PaddleOCR 実行時は Tesseract ワーカーを解放し、逆も同様です。ONNX Runtime は**シングルスレッド**設定（GitHub Pages は COOP/COEP ヘッダを送らないため `SharedArrayBuffer` が使えない）で、SIMD 有効・プロキシワーカー無効です。結果画面には使用エンジン名を表示します。
- **結果画面**: 撮影画像プレビュー、認識テキストの編集用 `<textarea>`、信頼度表示、「保存する」/「破棄」。
- **保存（IndexedDB / ライブラリなし）**: `{ id, createdAt(ISO), dateKey(YYYY-MM-DD ローカル), text, imageDataUrl(最長800pxのJPEG, 画質0.7) }`
- **一覧**: 保存日ごと（新しい日付が上）にサムネイル・テキスト・時刻・「コピー」・「削除」（`window.confirm` で確認）。
- **カレンダー**: 月グリッド（曜日 日月火水木金土）、前後月の切替、記録がある日にバッジ、日タップで一覧を絞り込み、「すべて表示」で解除。

## 開く / 使い方

- **クリップボード読み取り（貼り付けボタン）を使うには HTTP(S) 配信が必要**です（`navigator.clipboard` は secure context 前提）。ローカルでは例えば次のいずれか:
  - `python3 -m http.server 8000` の後、`http://localhost:8000/index.html`
  - `node tools/verify.mjs` は検証用の簡易サーバーも起動します（検証専用）。
- **カメラ撮影・画像選択**だけなら `file://` で直接 `index.html` を開いても動作します（ただし CDN 取得のためオンラインが必要）。
- 依存（Vue / Tesseract.js / traineddata）は **cdn.jsdelivr.net から都度ダウンロード**します。初回 OCR 時に言語データ等（数MB）を取得するため、初回は時間がかかります（ブラウザにキャッシュされます）。

### iPhone（SE3 / Safari）での注意

- 「カメラで撮影」はカメラ／写真ライブラリの選択ダイアログが出ます。ラベルを**大きく・明るく・正面から**撮ると精度が上がります。
- EXIF の向きは Safari が自動補正します（本アプリは `createImageBitmap({ imageOrientation: 'from-image' })`、非対応時は `<img>` 経由で描画）。EXIF 解析ライブラリは同梱していません。
- クリップボード画像の読み取りはユーザー操作＋許可が必要で、機種・iOS バージョンにより挙動が異なります。未対応時はエラーメッセージを表示します。
- 画面幅 375px を基準にしたモバイル優先デザイン。タップ領域は最小 44px、`safe-area-inset` に対応。

## セキュリティ（CSP）

`index.html` は厳格な CSP を `<meta http-equiv="Content-Security-Policy">` で指定します。`'unsafe-inline'` / `'unsafe-eval'` は使いません。インラインの `<script>` と `<style>` は **sha256 ハッシュ**で許可します（WASM のために `'wasm-unsafe-eval'` のみ許可）。

現在のポリシー:

```
default-src 'none';
script-src 'sha256-…(inline script)…' https://cdn.jsdelivr.net 'wasm-unsafe-eval';
style-src 'sha256-…(inline style)…';
img-src 'self' blob: data:;
connect-src https://cdn.jsdelivr.net data:;
worker-src blob:;
base-uri 'none';
form-action 'none'
```

- `script-src`: インラインscript（ハッシュ）、Vue/Tesseract 本体、Worker からの `importScripts`（jsdelivr）、WASM 実行（`wasm-unsafe-eval`）。
- `worker-src blob:`: Tesseract.js は Worker を Blob URL で起動します。
- `connect-src`: traineddata / ONNX Runtime の `.wasm` / PP-OCRv4 モデル・辞書の取得（すべて jsdelivr）と、Tesseract 埋め込み WASM の `data:` URI 取得。
- onnxruntime-web は遅延ロード（`<script>` 挿入）+ 内部の動的 `import()` も jsdelivr のため `script-src https://cdn.jsdelivr.net` の範囲内。追加の CSP 緩和は不要でした。
- `img-src`: 保存画像・プレビュー（`data:` / `blob:`）。

### CSP ハッシュの再生成

`index.html` のインライン `<script>` か `<style>` を編集したら、必ず以下を実行してハッシュを更新してください:

```
node tools/update_csp_hash.mjs
```

`tools/update_csp_hash.mjs`（依存なしの素の Node）が、インライン `<script>` と `<style>` の sha256 を計算し、CSP メタタグ内の該当トークンを書き換えます。

## 検証（自動テスト）

```
node tools/verify.mjs
```

Playwright + Chromium（プリインストール）で以下を確認します:

1. ローカル HTTP でリポジトリを配信し `index.html` を開く。
2. コンソール／ページエラーを収集し、**CSP 違反・JS エラーがあれば失敗**。
3. ページ内でラベル画像（`MODEL: KX-1234AB` / `S/N 5X-98765`）を canvas 生成 → File 化 → ファイル入力へ注入 → **切り抜きステージ**が出ることを確認 → 実ポインタイベントで四隅ハンドルをドラッグして枠を全体に拡大 → 「この範囲を読み取る」→ **PaddleOCR** で `/KX[-—_ ]?1234AB/i` と `/98765/` に一致、結果画面のエンジン表示が PaddleOCR であることを検証。
4. 「範囲を選び直す」→「全体を読み取る」→ **Tesseract** 経路でも同テキストに一致することを検証。
5. 保存 → 一覧へ切替 → 今日の日付見出しに記録が出る／カレンダーにバッジが付く → リロード後も記録が残る（IndexedDB 永続化）ことを検証。
6. 「日本語+英数字」モードに切替 → 初回ダウンロードのヒント（MBサイズ表示）が出ることを確認 → ラベル画像を注入 → 枠を拡大して「この範囲を読み取る」（jpn は Tesseract 経路）。実行コンテナに CJK フォントがあれば和文＋型番混在の画像で、なければ ASCII のみの画像で OCR が成功することを検証（どちらの経路を実行したかログに明示）。CSP 違反ゼロも同様に確認。

> 補足: 本サンドボックスの外向き通信ポリシーで `cdn.jsdelivr.net` が遮断されるため、**検証時のみ** jsdelivr へのリクエストを傍受し、`registry.npmjs.org` から取得した**同一バージョンの npm パッケージ**（`tools/.cdncache/` に自動キャッシュ、Git 追跡対象外）で応答します。実際のブラウザは jsdelivr から直接取得します。アプリ自体は一切改変しません。

## 固定した依存（バージョン）

すべて `cdn.jsdelivr.net`（npm ミラー）から取得。各 URL は npm レジストリで実在を確認済み。

| 依存 | バージョン | URL |
| --- | --- | --- |
| Vue 3（**ランタイム限定・prod**。テンプレート不使用＝ render 関数のみ） | 3.4.38 | `https://cdn.jsdelivr.net/npm/vue@3.4.38/dist/vue.runtime.global.prod.js` |
| Tesseract.js（本体） | 5.1.1 | `https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js` |
| Tesseract.js worker | 5.1.1 | `https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js` |
| tesseract.js-core（WASM, corePath） | 5.1.1 | `https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1`（SIMD+LSTM 版 `tesseract-core-simd-lstm.wasm.js` を自動選択） |
| eng 学習データ（langPath） | 1.0.0 | `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int`（`eng.traineddata.gz`、gzip 約2.95MB） |
| jpn 学習データ（langPath） | 1.0.0 | `https://cdn.jsdelivr.net/npm/@tesseract.js-data/jpn@1.0.0/4.0.0_best_int`（`jpn.traineddata.gz`、gzip 約2.0MB＝2,030,256 bytes。npm tarball から実測） |
| onnxruntime-web（WASM 実行、遅延ロード） | 1.19.2 | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.wasm.min.js`（`wasmPaths` も同 dist。`ort-wasm-simd-threaded.wasm` 約11.0MB） |
| PP-OCRv4 認識モデル + 辞書 | @gutenye/ocr-models 1.4.2 | `https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_rec_infer.onnx`（約10.8MB）/ `assets/ppocr_keys_v1.txt` |

- Vue は**ランタイム限定ビルド**を使用し、テンプレートコンパイラ（`new Function` が必要で CSP に抵触）を含みません。UI は `h()` の **render 関数**のみで構築しています。
- Tesseract の OEM は既定の LSTM_ONLY。これに合わせて core は `…-simd-lstm.wasm.js`、langPath は `4.0.0_best_int` を使用します。

## 既知の制限（PoC）

- **オンライン必須**: 依存を CDN から取得します（PaddleOCR 経路は初回約22MB、Tesseract 経路は数MB。いずれも同梱しない方針）。オフライン化するには自前ホスティングが必要です。
- **PaddleOCR は英数字系の範囲指定時のみ**。日本語の PP-OCR 認識モデル（ONNX 変換済み）は npm/jsdelivr 上で信頼できる配布が確認できなかったため、日本語モードは Tesseract `jpn` のままです。`jpn` は活字・組版向け訓練のため、**装飾的・小さい・低コントラストな和文印字の精度は限定的**です（範囲指定＋二値化前処理である程度改善）。
- PaddleOCR の辞書は中国語+ASCII のため、まれに漢字ノイズが混じることがあります（結果はテキストボックスで編集可能）。傾き補正・歪み補正は未実装で、大きく斜めのラベルでは精度が落ちます。範囲指定で読みたい行だけを囲むのが最も効果的です。
- **保存容量**: 画像は最長800px/JPEG 0.7 に縮小して保存しますが、IndexedDB の容量はブラウザ依存。多数保存すると上限に達する可能性があります。エクスポート機能はありません。
- **クリップボード読み取り**は secure context（HTTPS/localhost）とユーザー許可が必要で、対応状況はブラウザ依存。
- **保存画像の EXIF**は描画時に向きのみ反映。位置情報などのメタデータは保持しません。
- カレンダーは単月表示のみ。検索・タグ・編集後の再保存などの管理機能はありません。
- 検証は Chromium のみ（Playwright）。実機 Safari での自動テストは含みません。
