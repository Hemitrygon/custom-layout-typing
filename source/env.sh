# 開発の道具を使うための設定。使う前に読み込む：  . ./env.sh  （ルートで）
# Rust の道具は toolchain/ の中だけに置く（ホームの ~/.cargo・~/.rustup は使わない）。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export RUSTUP_HOME="$ROOT_DIR/toolchain/rustup"
export CARGO_HOME="$ROOT_DIR/toolchain/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
# wasm-pack が落とす道具（wasm-bindgen・wasm-opt）もここに置く（既定ではホームのキャッシュに入る）
export WASM_PACK_CACHE="$ROOT_DIR/toolchain/wasm-pack-cache"
# ビルドした WASM に、このパソコンのパス（ホームのフォルダ名など）を埋め込まない。
# Rust はエラーの文にソースの場所を入れるので、ルート・道具の場所を短い名前に置き換える
# 後に書いたものが優先されるので、広い（ルート）→ 狭い（道具の場所）の順に書く
export RUSTFLAGS="--remap-path-prefix=$ROOT_DIR=. --remap-path-prefix=$CARGO_HOME=cargo --remap-path-prefix=$RUSTUP_HOME=rustup"
# このパソコンだけの設定（Node の場所・Blender の場所・CHROMIUM_PATH など）は env.local.sh に書く（git に入れない。なくてもよい）
if [ -f "$ROOT_DIR/env.local.sh" ]; then . "$ROOT_DIR/env.local.sh"; fi
