# ラベルOCR（ブラウザ完結・単一HTML）

家電などの製品ラベル（型番・製造番号のシール）をスマホで撮影し、**WebAssembly (Tesseract.js) でブラウザ内ローカルOCR**して文字を抽出・編集し、写真とテキストを **IndexedDB** に保存する PoC アプリです。サーバーへ画像を送信しません。すべて 1 つの `index.html` で動作します。

- UI は日本語。iPhone SE3 の Safari と、デスクトップの主要ブラウザで動作します。
- 保存した記録は**保存日でグループ化**して一覧表示し、**月カレンダー**で日付を絞り込めます。

## これは何か / 主な機能

- **画像の入力（3通り）**
  - 「カメラで撮影」: `<input type="file" accept="image/*" capture="environment">`
  - 「画像を選択」: 端末内の画像ファイルを選択
  - 「クリップボードから貼り付け」: `navigator.clipboard.read()`。未対応・拒否時は日本語エラーを表示。ページ上で `Ctrl/Cmd+V`（paste イベント）にも対応。
- **前処理（canvas）**: 長辺 ≤ 約1600px に縮小 → グレースケール → コントラスト伸長（2〜98パーセンタイル）。前処理後の canvas を OCR に渡します。
- **認識モード（撮影画面・撮影ボタンの上）**: 2つのセグメントボタンから選択でき、選択は `localStorage` に保存され次回起動時も復元されます。
  - 「英数字(型番向け)」（既定・従来どおり）: Tesseract 言語 `eng`。
  - 「日本語+英数字」: Tesseract 言語 `jpn`。`jpn` の学習データは英数字も認識できるため、和文と型番が混在するラベルにはこちらを使用します（`eng` と `jpn` は別々の npm パッケージとして配布されており、1つの `langPath` から両方を取得できないため `jpn+eng` ではなく `jpn` 単体を使用）。初回切替時は日本語の学習データ（gzip 約2.0MB）を追加ダウンロードするため時間がかかる旨のヒントを表示します。
- **OCR（進捗表示）**: Tesseract のロガーで進捗バーとステータス（例: 認識中…）を表示。ワーカーは常に**最大1つだけ**保持し、モード切替後に次の OCR を実行するタイミングで前のワーカーを `terminate()` してから新しいワーカーを作成します（iPhone のメモリ対策）。同じモードのままなら既存ワーカーを再利用します。
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
- `connect-src`: traineddata の取得（jsdelivr）と、埋め込み WASM の `data:` URI 取得。
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
3. ページ内でラベル画像（`MODEL: KX-1234AB` / `S/N 5X-98765`）を canvas 生成 → File 化 → ファイル入力へ注入 → OCR 完了を待ち、テキストが `/KX[-—_ ]?1234AB/i` と `/98765/` に一致することを検証。
4. 保存 → 一覧へ切替 → 今日の日付見出しに記録が出る／カレンダーにバッジが付くことを検証。
5. リロード後も記録が残る（IndexedDB 永続化）ことを検証。
6. 「日本語+英数字」モードに切替 → 初回ダウンロードのヒント（MBサイズ表示）が出ることを確認 → ラベル画像を注入して OCR。実行コンテナに CJK フォント（`fc-list | grep -i -e cjk -e noto`）があれば和文＋型番混在の画像で、なければ ASCII のみの画像で `jpn` ワーカー経由の OCR が成功することを検証（どちらの経路を実行したかログに明示）。CSP 違反ゼロも同様に確認。

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

- Vue は**ランタイム限定ビルド**を使用し、テンプレートコンパイラ（`new Function` が必要で CSP に抵触）を含みません。UI は `h()` の **render 関数**のみで構築しています。
- Tesseract の OEM は既定の LSTM_ONLY。これに合わせて core は `…-simd-lstm.wasm.js`、langPath は `4.0.0_best_int` を使用します。

## 既知の制限（PoC）

- **オンライン必須**: 依存を CDN から取得します（WASM/traineddata 約15MB は同梱しない方針）。オフライン化するには自前ホスティングが必要です。
- **OCR は既定で英数字前提**（`eng`）。「日本語+英数字」（`jpn`）モードも選択できますが、`jpn` の学習データは主に活字・組版された文章向けに訓練されており、**家電ラベルのような装飾的・小さい・低コントラストな印字での日本語認識精度は限定的**です（英数字部分の認識は比較的安定）。前処理は単純なグレースケール＋コントラスト伸長のみで、二値化・傾き補正・歪み補正は未実装。手ブレ・低コントラスト・光沢のあるラベルでは精度が落ちます。
- **保存容量**: 画像は最長800px/JPEG 0.7 に縮小して保存しますが、IndexedDB の容量はブラウザ依存。多数保存すると上限に達する可能性があります。エクスポート機能はありません。
- **クリップボード読み取り**は secure context（HTTPS/localhost）とユーザー許可が必要で、対応状況はブラウザ依存。
- **保存画像の EXIF**は描画時に向きのみ反映。位置情報などのメタデータは保持しません。
- カレンダーは単月表示のみ。検索・タグ・編集後の再保存などの管理機能はありません。
- 検証は Chromium のみ（Playwright）。実機 Safari での自動テストは含みません。
