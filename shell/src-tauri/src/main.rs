// M0 scaffold — verify with cargo check once Rust is installed.
// Prevents an extra console window on Windows in release builds; DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    partner_shell_lib::run()
}
