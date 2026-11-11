#!/usr/bin/env bash
# 手元で開く：開発用のサーバーを立てて、ブラウザで開く。どこから実行してもよい。
#     bash start.sh   （このフォルダで。ほかの場所からなら、このファイルのパスを指定する）
# 止めるときは、このターミナルで Ctrl+C。
# 足りないもの（npm の部品・Rust の出力）は、ここで用意する。
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
. ./env.sh

# npm がないとき：入れ方を出す（Node の場所が特別なら env.local.sh で PATH に足す）
if ! command -v npm >/dev/null 2>&1; then
  echo 'npm が見つかりません。Node.js（npm を含む。https://nodejs.org）を入れてください'
  exit 1
fi

# Rust の出力（WASM）がないとき：作る
if [ ! -f core/pkg/typing_core.js ]; then
  echo '== Rust を WebAssembly にします（初回だけ。1 分ほど）'
  (cd core && wasm-pack --quiet build --target web)
fi

# npm の部品がないとき：入れる
if [ ! -d web/node_modules/vite ]; then
  echo '== npm の部品を入れます（初回だけ）'
  (cd web && npm install --no-audit --no-fund)
fi

cd web
echo '== 開きます：http://localhost:5173/   （止めるときは Ctrl+C）'
exec npm run --silent dev -- --open
