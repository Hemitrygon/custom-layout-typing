# カスタム配列タイピング

QWERTY配列、大西配列や自分で作ったキー配列で、日本語（ローマ字入力）のタイピングを練習するためのサイトです。

- 普通のキーボードのまま、別の配列を練習できます（押したキーの位置を、選んだ配列の文字に読み替え）。
- 配列エディタで、キーごとに文字を割り当てて、自分の配列を作れます。
- スコアの記録、苦手な文字の分析、だんだん制限時間が短くなる「シャトルラン」があります。

## 使い方

`index.html` をブラウザ（Chrome / Edge / Firefox などのパソコン版）で開くだけで使えます。インストールは要りません。1つのファイルで動きます。

## データとプライバシー

- 練習の記録や設定は、使っているブラウザの中にだけ保存されます。外部のサーバーには送りません。
- 外から読み込むのは、画面のフォント（Google Fonts）と、「漢字をかな自動変換」を使ったときだけの変換用の辞書（jsDelivr または unpkg）です。

## AI の使用について

このサイトのコードや背景素材、シャトルラン問題文、練習文の一部（「日常」）はAI（Anthropic Claude Code）生成です。
どう作るかの判断、動作の確認、公開する内容の確認は、作者が行っています。

## ソースコードとビルド

`index.html` は、`source/` の本体から作ったものです。コードは本体とほぼ同じ形のまま読めます（違いは、開発用のツールを取り除いたことと、背景の動画と画像をファイルの中に入れて1つのファイルにしたことだけです）。

| ファイル | 中身 |
|---|---|
| `source/typing_practice_vX.Y.Z.html` | 本体（HTML・CSS・JavaScript。`scene/` と同じ場所に置けば、ブラウザで直接開いても動きます） |
| `source/scene/` | 背景のキーボードの動画と画像 |
| `source/csp_hash.mjs` | 本体のスクリプトを直したあと、CSP（スクリプトのハッシュ）を更新する |
| `source/build.mjs` | `index.html` を作る |

ビルドには Node.js だけが要ります（npm の部品は使いません）。

```
cd source
node csp_hash.mjs
node build.mjs
```

1つ上のフォルダに `index.html` ができます。

## ライセンス

Copyright (C) 2026 Hemitrygon

GNU General Public License v3.0（GPL-3.0）で公開しています。GPL-3.0 の条件のもとで、だれでも自由に使用・複製・改変・再配布できます。改変したものを配布するときは、そのソースコードも GPL-3.0 で公開してください。無保証です。

詳細 [LICENSE](LICENSE)

- 「Hemitrygon」の名前とロゴは、GPL-3.0 の対象外です。改変したものを配布するときは、Hemitrygon の名前とロゴを外してください。
- 使用している第三者のもの（ライセンスの全文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：Tailwind CSS（MIT License・ビルド済みの CSS を埋め込み）、kuromoji.js（Apache License 2.0・漢字かな変換を使ったときだけ CDN から読み込み）、Inter / Noto Sans JP / JetBrains Mono / Yusei Magic（SIL Open Font License 1.1・Google Fonts から読み込み）。標準の練習文の『こころ』冒頭といろは歌はパブリックドメインです。
