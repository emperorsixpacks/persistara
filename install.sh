#!/usr/bin/env bash
# Persistara installer.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/persistara/main/install.sh | bash
#
# Safer: download it, read it, then run it:
#   curl -fsSL <url> -o install.sh && less install.sh && bash install.sh
#
# What it does (nothing needs sudo; it never touches system directories):
#   1. clones the source into  $PERSISTARA_INSTALL_DIR   (default ~/.local/share/persistara/app)
#   2. installs the locked dependencies and builds the CLI
#   3. writes a `persistara` command to  $PERSISTARA_BIN_DIR  (default ~/.local/bin)
#   4. adds that directory to your shell PATH (a marked block you can remove; skip with --no-modify-path)
#   5. creates your private workspace  $PERSISTARA_HOME  (default ~/.persistara-workspace) with a .env template
#
# It NEVER overwrites an existing .env, keys, journals or contract artifact, and --uninstall never deletes your workspace.
# Persistara needs a deployed authority contract and your own NEAR/NEAR AI accounts; installing the program does not create them.
set -euo pipefail

REPO_URL="${PERSISTARA_REPO:-https://github.com/emperorsixpacks/persistara.git}"
REF="${PERSISTARA_REF:-main}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_DIR="${PERSISTARA_INSTALL_DIR:-$DATA_HOME/persistara/app}"
BIN_DIR="${PERSISTARA_BIN_DIR:-$HOME/.local/bin}"
WORKSPACE="${PERSISTARA_HOME:-$HOME/.persistara-workspace}"
WASM_SOURCE="${PERSISTARA_WASM:-}"
MARKER_BEGIN="# >>> persistara >>>"
MARKER_END="# <<< persistara <<<"
SHIM_MARK="# persistara-managed-shim"
DRY_RUN=0
UNINSTALL=0
MODIFY_PATH=1
FORCE=0

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]
  --ref <branch|tag|commit>  version to install (default: main; pin a tag or full commit for reproducibility)
  --dry-run                  print what would happen and change nothing
  --no-modify-path           do not edit any shell startup file
  --force                    replace local changes inside the install directory (never your workspace)
  --uninstall                remove the app, command and PATH block; your workspace is kept
  -h, --help                 show this help
Environment: PERSISTARA_REPO, PERSISTARA_REF, PERSISTARA_INSTALL_DIR, PERSISTARA_BIN_DIR, PERSISTARA_HOME,
             PERSISTARA_WASM (path to your deployment's authority WASM to copy into the workspace), PERSISTARA_NO_MODIFY_PATH=1
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --no-modify-path) MODIFY_PATH=0; shift ;;
      --force) FORCE=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
  done
  [ "${PERSISTARA_NO_MODIFY_PATH:-0}" = 1 ] && MODIFY_PATH=0
  return 0
}

# Paths are written into a shell script, so refuse anything that would need escaping.
safe_path() {
  case "$2" in
    /*) ;;
    *) die "$1 must be an absolute path (got: $2)" ;;
  esac
  case "$2" in
    *[!A-Za-z0-9_./@+:,=-]*) die "$1 contains characters this installer will not embed in a script: $2" ;;
  esac
}

detect_rc_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$(uname -s)" = Darwin ] && [ ! -f "$HOME/.bashrc" ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
    fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/persistara.fish" ;;
    *) echo "$HOME/.profile" ;;
  esac
}

on_path() { case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; *) return 1 ;; esac; }

remove_path_block() {
  local rc="$1" tmp
  [ -f "$rc" ] && grep -qF "$MARKER_BEGIN" "$rc" || return 0
  tmp="$(mktemp)"
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip{print}' "$rc" > "$tmp"
  run cp "$tmp" "$rc"; rm -f "$tmp"
}

uninstall() {
  say "Uninstalling Persistara (your workspace $WORKSPACE is NOT touched)."
  local shim="$BIN_DIR/persistara"
  if [ -f "$shim" ] && grep -qF "$SHIM_MARK" "$shim"; then run rm -f "$shim"; say "  removed $shim"; else say "  no managed command at $shim"; fi
  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/.persistara-install" ]; then run rm -rf "$INSTALL_DIR"; say "  removed $INSTALL_DIR"
  elif [ -e "$INSTALL_DIR" ]; then warn "$INSTALL_DIR was not created by this installer (no .persistara-install marker); left alone"; fi
  for rc in "$HOME/.zshrc" "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/persistara.fish"; do
    if [ -f "$rc" ] && grep -qF "$MARKER_BEGIN" "$rc"; then remove_path_block "$rc"; say "  removed PATH block from $rc"; fi
  done
  say "Done. Keys, .env and journals in $WORKSPACE were kept on purpose; delete that folder yourself only if you have backups."
}

package_manager() {
  if command -v corepack >/dev/null 2>&1; then PM=(corepack pnpm); export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  elif command -v pnpm >/dev/null 2>&1; then PM=(pnpm)
  else die "pnpm is required. Install Node.js 20+ (it includes corepack) or pnpm: https://pnpm.io/installation"; fi
}

fetch_source() {
  command -v git >/dev/null 2>&1 || die "git is required"
  if [ -d "$INSTALL_DIR/.git" ] && [ -f "$INSTALL_DIR/.persistara-install" ]; then
    if [ -n "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] && [ "$FORCE" != 1 ]; then die "$INSTALL_DIR has local changes; re-run with --force to replace them"; fi
    say "Updating existing install at $INSTALL_DIR"
  elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    die "$INSTALL_DIR exists and was not created by this installer; choose another PERSISTARA_INSTALL_DIR"
  else
    run mkdir -p "$INSTALL_DIR"; run git -C "$INSTALL_DIR" init -q
  fi
  # fetch by ref so a branch, tag or full commit SHA all work
  run git -C "$INSTALL_DIR" fetch -q --depth 1 "$REPO_URL" "$REF"
  run git -C "$INSTALL_DIR" checkout -q --force --detach FETCH_HEAD
  if [ "$DRY_RUN" != 1 ]; then
    COMMIT="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
    printf 'ref=%s\ncommit=%s\ninstalled=%s\n' "$REF" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$INSTALL_DIR/.persistara-install"
    say "Installed commit $COMMIT (ref: $REF)"
  fi
}

build() {
  package_manager
  say "Installing locked dependencies and building (this downloads a project-local Node runtime; your global Node is unchanged)..."
  if [ "$DRY_RUN" = 1 ]; then say "  [dry-run] (cd $INSTALL_DIR && ${PM[*]} install --frozen-lockfile && ${PM[*]} build)"; return 0; fi
  ( cd "$INSTALL_DIR" && "${PM[@]}" install --frozen-lockfile && "${PM[@]}" build ) || die "build failed; nothing was added to your PATH"
  [ -f "$INSTALL_DIR/dist/scripts/cli.js" ] || die "build finished but dist/scripts/cli.js is missing"
}

write_shim() {
  local shim="$BIN_DIR/persistara"
  if [ -e "$shim" ] && ! grep -qF "$SHIM_MARK" "$shim" 2>/dev/null; then die "$shim already exists and is not managed by this installer; remove it or set PERSISTARA_BIN_DIR"; fi
  if [ "$DRY_RUN" = 1 ]; then say "  [dry-run] write $shim -> $INSTALL_DIR/bin/persistara --project $WORKSPACE"; return 0; fi
  mkdir -p "$BIN_DIR"
  printf '#!/bin/sh\n%s\nexec '"'"'%s/bin/persistara'"'"' --project '"'"'%s'"'"' "$@"\n' "$SHIM_MARK" "$INSTALL_DIR" "$WORKSPACE" > "$shim"
  chmod 755 "$shim"
}

add_to_path() {
  [ "$MODIFY_PATH" = 1 ] || { say "Skipping PATH changes. Add this yourself: export PATH=\"$BIN_DIR:\$PATH\""; return 0; }
  if on_path; then say "$BIN_DIR is already on your PATH."; return 0; fi
  local rc; rc="$(detect_rc_file)"
  if [ -f "$rc" ] && grep -qF "$MARKER_BEGIN" "$rc"; then say "PATH block already present in $rc"; return 0; fi
  say "Adding $BIN_DIR to your PATH in $rc (remove the marked block, or run install.sh --uninstall, to undo)."
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  mkdir -p "$(dirname "$rc")"
  case "$rc" in
    *.fish) printf '%s\nfish_add_path %s\n%s\n' "$MARKER_BEGIN" "$BIN_DIR" "$MARKER_END" >> "$rc" ;;
    *) printf '\n%s\nexport PATH="%s:$PATH"\n%s\n' "$MARKER_BEGIN" "$BIN_DIR" "$MARKER_END" >> "$rc" ;;
  esac
  NEEDS_RESTART="$rc"
}

init_workspace() {
  say "Workspace: $WORKSPACE (private; holds your .env, keys and journals)"
  run mkdir -p "$WORKSPACE"; run chmod 700 "$WORKSPACE"
  if [ -e "$WORKSPACE/.env" ]; then say "  kept existing $WORKSPACE/.env"
  elif [ "$DRY_RUN" = 1 ]; then say "  [dry-run] create $WORKSPACE/.env from .env.example (mode 600)"
  else cp "$INSTALL_DIR/.env.example" "$WORKSPACE/.env"; chmod 600 "$WORKSPACE/.env"; say "  created $WORKSPACE/.env (edit it; never paste its secrets into chat)"; fi
  local artifact="$WORKSPACE/target/near/persistara_authority/persistara_authority.wasm"
  if [ -n "$WASM_SOURCE" ]; then
    [ -f "$WASM_SOURCE" ] || die "PERSISTARA_WASM does not point to a file: $WASM_SOURCE"
    if [ -e "$artifact" ]; then say "  kept existing authority WASM"
    else run mkdir -p "$(dirname "$artifact")"; run cp "$WASM_SOURCE" "$artifact"; say "  copied authority WASM"; fi
  fi
  if [ "$DRY_RUN" != 1 ] && [ -f "$artifact" ]; then
    local sum; if command -v sha256sum >/dev/null 2>&1; then sum="$(sha256sum "$artifact" | cut -d' ' -f1)"; else sum="$(shasum -a 256 "$artifact" | cut -d' ' -f1)"; fi
    say "  authority WASM sha256: $sum (Persistara requires it to match your deployed contract's code hash)"
  elif [ ! -f "$artifact" ]; then
    say "  No authority WASM yet. Connecting to an existing deployment needs that deployment's exact WASM at:"
    say "    $artifact"
    say "  (a rebuild will NOT match an existing deployment; see docs/CONTRACTS.md)"
  fi
}

check_extras() {
  command -v near >/dev/null 2>&1 || warn "the official NEAR CLI ('near') was not found; owner wallet sign-in needs it. See docs/TERMINAL.md."
}

verify_install() {
  [ "$DRY_RUN" = 1 ] && return 0
  "$BIN_DIR/persistara" --help >/dev/null 2>&1 || die "installed command failed its --help self-check; see $INSTALL_DIR"
  say "Self-check passed: $BIN_DIR/persistara --help runs."
}

main() {
  parse_args "$@"
  [ -n "${HOME:-}" ] || die "HOME is not set"
  case "$(uname -s)" in Linux|Darwin) ;; *) die "unsupported OS: $(uname -s). Use Linux, macOS or WSL." ;; esac
  [ "$(id -u)" != 0 ] || warn "running as root; a normal user install is recommended"
  safe_path PERSISTARA_INSTALL_DIR "$INSTALL_DIR"; safe_path PERSISTARA_BIN_DIR "$BIN_DIR"; safe_path PERSISTARA_HOME "$WORKSPACE"
  if [ "$UNINSTALL" = 1 ]; then uninstall; return 0; fi
  [ "$DRY_RUN" = 1 ] && say "Dry run: nothing will be changed."
  NEEDS_RESTART=""
  fetch_source
  build
  write_shim
  add_to_path
  init_workspace
  check_extras
  verify_install
  say ""
  if [ "$DRY_RUN" = 1 ]; then say "Dry run complete; nothing was changed."; return 0; fi
  say "Persistara is installed."
  [ -n "$NEEDS_RESTART" ] && say "Open a new terminal (or run: . \"$NEEDS_RESTART\") so 'persistara' is on your PATH."
  say "Next: edit $WORKSPACE/.env (see docs/TERMINAL.md), then run:  persistara"
}

# Everything runs from main so a truncated download cannot execute half a script.
main "$@"
