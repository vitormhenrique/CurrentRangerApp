# CurrentRanger Desktop App — justfile
# Requires: just, cargo, node/npm
# Install just: cargo install just  OR  brew install just

app_dir := justfile_directory()
frontend_dir := app_dir
tauri_dir := app_dir + "/src-tauri"

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
