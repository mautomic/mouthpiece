#!/usr/bin/env bash
# install.sh: set up Mouthpiece for this macOS user. Safe to re-run. MOUTHPIECE_DRY_RUN=1 prints the plan only.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${MOUTHPIECE_DRY_RUN:-0}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
BIN_DIR="$HOME/.local/bin"
MP="$BIN_DIR/mouthpiece"
WITH_HELPER=0
WITH_HOOKS=0
WITH_AGENT=0
WITH_KOKORO=0

usage() {
  echo "usage: ./install.sh [--with-helper] [--with-hooks] [--with-agent] [--with-kokoro]"
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-helper) WITH_HELPER=1 ;;
    --with-hooks) WITH_HOOKS=1 ;;
    --with-agent) WITH_AGENT=1 ;;
    --with-kokoro) WITH_KOKORO=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

run() { printf '+ '; printf '%q ' "$@"; printf '\n'; if [ "$DRY_RUN" != 1 ]; then "$@"; fi; }
say_step() { echo; echo "==> $*"; }

write_cli_wrapper() {
  echo "+ write CLI wrapper to $MP"
  if [ "$DRY_RUN" != 1 ]; then
    printf '#!/usr/bin/env bash\nexec "%s" --config="%s" --no-env-file "%s" "$@"\n' \
      "$BUN" "$REPO/bunfig.toml" "$REPO/packages/cli/src/main.ts" > "$MP"
    chmod +x "$MP"
  fi
}

[ "$(uname -s)" = Darwin ] || { echo "Mouthpiece requires macOS." >&2; exit 1; }

say_step "Checking Bun"
if [ ! -x "$BUN" ]; then
  echo "Bun not found at $BUN."
  run bash -c 'curl -fsSL https://bun.sh/install | bash'
fi
if [ "$DRY_RUN" != 1 ] || [ -x "$BUN" ]; then
  version="$("$BUN" -e 'console.log(Bun.version)')"
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\. ]]; then
    echo "Could not determine Bun version at $BUN: $version" >&2; exit 1
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 2 ]; }; then
    echo "Bun at $BUN is $version; Mouthpiece requires Bun 1.2 or later." >&2; exit 1
  fi
  arch="$("$BUN" -e 'console.log(process.arch)')"
  if [ "$(uname -m)" = arm64 ] && [ "$arch" != arm64 ]; then
    echo "Bun at $BUN is $arch (Rosetta). Install native arm64 Bun first." >&2; exit 1
  fi
fi

say_step "Installing dependencies"
(
  cd "$REPO"
  run "$BUN" install
)

say_step "Linking the mouthpiece CLI into $BIN_DIR"
run mkdir -p "$BIN_DIR"
# Pin the repo's bunfig.toml and skip .env so a project's own bunfig.toml can't break the CLI.
write_cli_wrapper
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: add $BIN_DIR to your PATH." ;; esac

if [ "$WITH_HELPER" = 1 ]; then
  say_step "Building helper (hotkeys, menubar, mic pause)"
  if command -v swiftc >/dev/null 2>&1; then
    run "$MP" build-helper || echo "Helper build failed; continuing without hotkeys, menubar or mic pause."
  else
    echo "swiftc not found; skipping build-helper (install Xcode Command Line Tools to enable)."
  fi
fi

if [ "$WITH_KOKORO" = 1 ]; then
  say_step "Local Kokoro voice"
  run "$MP" kokoro install || echo "Kokoro install failed; continuing with macOS say."
fi

if [ "$WITH_HOOKS" = 1 ]; then
  say_step "Claude Code hooks"
  run "$MP" install-hooks
  if command -v codex >/dev/null 2>&1; then
    say_step "Codex hooks"
    run "$MP" install-hooks --target codex || echo "Codex hook install failed; continuing."
    echo "→ In Codex, run /hooks to trust them."
  fi
  if command -v gemini >/dev/null 2>&1; then
    say_step "Gemini CLI hooks"
    run "$MP" install-hooks --target gemini || echo "Gemini hook install failed; continuing."
  fi
  if command -v devin >/dev/null 2>&1; then
    say_step "Devin hooks"
    run "$MP" install-hooks --target devin || echo "Devin hook install failed; continuing."
    echo "→ In Devin, run /hooks to confirm they loaded."
  fi
fi

if [ "$WITH_AGENT" = 1 ]; then
  say_step "Background daemon (launchd)"
  run mkdir -p "$HOME/.config/mouthpiece"
  run "$MP" install-agent
fi

cat <<EOF

Done. Start the daemon in this terminal with: mouthpiece start
Optional integrations: rerun ./install.sh with --with-helper, --with-hooks, --with-agent, or --with-kokoro.
Config: ~/.config/mouthpiece/config.toml
EOF
