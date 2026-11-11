#!/bin/bash
# 一括チェック：Rust のテスト（旧版（v5）の正解データとの照らし合わせ）→ clippy と rustfmt → WASM のビルド
# → WASM の口 → 画面のビルド → ブラウザでの通し確認 → 旧版（v5）のバックアップを復元する確かめ → 配るファイルに個人のパスがないか。
#     bash check.sh [スクリーンショットの保存先.png]   （ルートで）
# どこかで失敗したら、そこで止まる。
set -euo pipefail
cd "$(dirname "$0")"
. ./env.sh

echo '== 1. Rust のテスト'
(cd core && cargo test --quiet)
echo '== 2. clippy と rustfmt（Rust の書き方と書式のチェック。書式が違えば cargo fmt で直す）'
(cd core && cargo clippy --quiet --all-targets -- -D warnings && cargo fmt --check)
echo '== 3. WASM のビルド（core/pkg/）'
(cd core && wasm-pack --quiet build --target web --release)
echo '== 4. WASM の口（core/pkg/ を Node で呼ぶ・正解データの一部と照らし合わせ）'
(cd web && node api_test.mjs)
echo '== 4b. 壊れた入力で Rust が止まらないか（WASM の口を変な値で何千回も呼ぶ）'
(cd web && node fuzz_test.mjs 3000 1 && node fuzz_test.mjs 3000 2)
echo '== 5. 3D のキーの対応表と、画面のビルド（web/dist/）'
(cd web && node scripts/check_model_keys.mjs)
(cd web && npm run --silent build -- --logLevel warn)
echo '== 6. ブラウザでの通し確認'
(cd web && node smoke_test.mjs "${1:-}")
echo '== 7. データの引き継ぎ（旧版 v5 で作ったバックアップを、今の版で復元する）'
if ls old_versions/typing_practice_v5.*.html >/dev/null 2>&1; then
  (cd web && node v5_backup_test.mjs)
else
  echo 'skip 旧版 v5 の本体（old_versions/typing_practice_v5.Y.Z.html）がないので飛ばした（置き方は 開発手順.md）'
fi
echo '== 8. 配るファイル（web/dist/）に、このパソコンのパス・ユーザー名が入っていないか'
# 名前はスクリプトに書かず、実行したときに取る（ホームのフォルダ・ユーザー名・ルートの絶対パス）
LEAK=$(find web/dist -type f -print0 | xargs -0 strings -n 4 | grep -F -e "$HOME" -e "$(whoami)" -e "$PWD" | head -5 || true)
if [ -n "$LEAK" ]; then echo "✗ 配るファイルに入っている：" ; echo "$LEAK"; exit 1; fi
echo 'ok   見つからなかった'
echo '== すべて合格'
