// CurrentRanger Desktop App — main.rs
// This is the binary entry point; all logic lives in lib.rs.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    current_ranger_lib::run();
}
