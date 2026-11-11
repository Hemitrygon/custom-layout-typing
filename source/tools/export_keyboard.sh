#!/bin/bash
# Blender のキーボード（.blend。このリポジトリには入れていない）を、画面で使う glb に書き出す（.blend は保存しない）。
#     bash tools/export_keyboard.sh [keyboard.blend の場所]   （ルートで）
# .blend の場所は引数か、環境変数 KEYBOARD_BLEND。Blender のコマンドは環境変数 BLENDER（既定は blender）。
# どちらも env.local.sh に書いておける（env.sh が読み込む）。
# 出力：web/public/models/keyboard.glb（Draco 圧縮。キーは Key_<名前> の別々の物体、親は KB_Root）
set -euo pipefail
cd "$(dirname "$0")/.."
. ./env.sh
BLEND="${1:-${KEYBOARD_BLEND:-}}"
[ -n "$BLEND" ] && [ -f "$BLEND" ] || { echo "✗ keyboard.blend の場所を引数か KEYBOARD_BLEND で指定してください"; exit 1; }
OUT="$PWD/web/public/models/keyboard.glb"
read -r -a RUN <<< "${BLENDER:-blender}"
"${RUN[@]}" -b "$BLEND" --python "$PWD/tools/export_keyboard.py" -- "$OUT" draco | grep -E "^==|Finished|Error" || true
ls -la "$OUT"
