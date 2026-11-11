//! カスタム配列タイピングの中身（Rust）：変換・判定・スコア・記録。WebAssembly にしてブラウザで動かす。
//! 旧版（v5。1 ファイルの typing_practice_v5.4.5.html）の計算を、同じ答えになるよう移したもの。
//! 同じ答えになることは、tests/golden_*.rs が旧版（v5）から取った正解データ（tests/golden/）と比べて確かめる。

pub mod dict;
pub mod js;
pub mod kana;
pub mod keys;
pub mod layout;
pub mod lz;
pub mod records;
pub mod score;
pub mod shuttle;
pub mod shuttle_run;
pub mod text;
pub mod typing;
pub mod wasm;

use wasm_bindgen::prelude::*;

/// この中身の版。画面に出して、WASM が読み込めたかの確認に使う。
#[wasm_bindgen]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert_eq!(core_version(), "0.1.0");
    }
}
