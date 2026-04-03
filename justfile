# CurrentRanger Desktop App — justfile
# Requires: just, cargo, node/npm
# Install just: cargo install just  OR  brew install just

app_dir      := justfile_directory()
frontend_dir := app_dir
tauri_dir    := app_dir + "/src-tauri"
mock_dir     := app_dir + "/cr-mock"

# Default: list available commands
default:
    @just --list

# Install all dependencies (Node + Rust)
install:
    npm install
    cargo fetch --manifest-path {{tauri_dir}}/Cargo.toml

# Start the Tauri dev server (builds frontend + opens app window)
dev:
    npm run tauri -- dev

# Alias for dev
tauri-dev: dev

# Build release binaries
build:
    npm run tauri -- build

# Alias for build
tauri-build: build

# Run Rust tests only
test:
    cargo test --manifest-path {{tauri_dir}}/Cargo.toml

# Run frontend type check
check-frontend:
    npm run type-check

# Run all checks (Rust + TypeScript)
check: check-frontend
    cargo check --manifest-path {{tauri_dir}}/Cargo.toml

# Lint Rust code with clippy
lint:
    cargo clippy --manifest-path {{tauri_dir}}/Cargo.toml -- -D warnings
    npm run lint

# Format Rust and frontend code
fmt:
    cargo fmt --manifest-path {{tauri_dir}}/Cargo.toml
    npm run fmt

# Clean build artifacts
clean:
    cargo clean --manifest-path {{tauri_dir}}/Cargo.toml
    rm -rf {{app_dir}}/dist
    rm -rf {{app_dir}}/node_modules/.vite

# Build only the frontend (Vite)
build-frontend:
    npm run build

# Watch/type-check frontend in background
watch-frontend:
    npm run type-check -- --watch

# Run Rust tests with output (verbose)
test-verbose:
    cargo test --manifest-path {{tauri_dir}}/Cargo.toml -- --nocapture

# Show Rust dependency tree
deps:
    cargo tree --manifest-path {{tauri_dir}}/Cargo.toml

# ── Mock device ────────────────────────────────────────────────────────────────

# Build + run the CurrentRanger R3 mock with interactive TUI (auto-creates a PTY)
mock:
    cargo run --manifest-path {{mock_dir}}/Cargo.toml

# Build + run the mock on a specific serial port  (e.g.: just mock-port /dev/ttyUSB0)
mock-port PORT:
    cargo run --manifest-path {{mock_dir}}/Cargo.toml -- {{PORT}}

# Build the mock in release mode (faster sample generation)
mock-build:
    cargo build --release --manifest-path {{mock_dir}}/Cargo.toml

# Run the release build of the mock
mock-release:
    cargo build --release --manifest-path {{mock_dir}}/Cargo.toml
    {{mock_dir}}/target/release/cr-mock

# Run the release build of the mock on a specific port
mock-release-port PORT:
    cargo build --release --manifest-path {{mock_dir}}/Cargo.toml
    {{mock_dir}}/target/release/cr-mock {{PORT}}

# Run app + mock side-by-side (two panes — requires tmux)
dev-with-mock:
    tmux new-session \; \
        send-keys "just mock" C-m \; \
        split-window -h \; \
        send-keys "sleep 1 && just dev" C-m
