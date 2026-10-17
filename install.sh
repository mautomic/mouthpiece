#!/usr/bin/env bash
# install.sh: set up Mouthpiece for this macOS user. Safe to re-run. MOUTHPIECE_DRY_RUN=1 prints the plan only.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${MOUTHPIECE_DRY_RUN:-0}"
BUN="${BUN:-$HOME/.bun/bin/bun}"
BIN_DIR="$HOME/.local/bin"
MP="$BIN_DIR/mouthpiece"

run() { echo "+ $*"; if [ "$DRY_RUN" != 1 ]; then "$@"; fi; }
say_step() { echo; echo "==> $*"; }

[ "$(uname -s)" = Darwin ] || { echo "Mouthpiece requires macOS." >&2; exit 1; }

say_step "Checking Bun"
if [ ! -x "$BUN" ]; then
  echo "Bun not found at $BUN."
  run bash -c 'curl -fsSL https://bun.sh/install | bash'
fi
if [ "$DRY_RUN" != 1 ] || [ -x "$BUN" ]; then
  arch="$("$BUN" -e 'console.log(process.arch)')"
  if [ "$(uname -m)" = arm64 ] && [ "$arch" != arm64 ]; then
    echo "Bun at $BUN is $arch (Rosetta). Install native arm64 Bun first." >&2; exit 1
  fi
fi

say_step "Installing dependencies"
run bash -c "cd '$REPO' && '$BUN' install"

say_step "Linking the mouthpiece CLI into $BIN_DIR"
run mkdir -p "$BIN_DIR"
run bash -c "printf '#!/usr/bin/env bash\nexec \"%s\" \"%s\" \"\$@\"\n' '$BUN' '$REPO/packages/cli/src/main.ts' > '$MP' && chmod +x '$MP'"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: add $BIN_DIR to your PATH." ;; esac

say_step "Building global hotkeys"
if command -v swiftc >/dev/null 2>&1; then
  run "$MP" build-hotkeys || echo "Hotkey build failed; continuing without hotkeys."
else
  echo "swiftc not found; skipping build-hotkeys (install Xcode Command Line Tools to enable)."
fi

say_step "TTS provider key (optional)"
if [ "$DRY_RUN" != 1 ] && [ -t 0 ]; then
  read -rsp "Inworld API key (Enter to skip and use macOS say): " key; echo
  if [ -n "$key" ]; then printf '%s' "$key" | "$MP" auth inworld; fi
else
  echo "+ (skipped prompt) printf <key> | $MP auth inworld"
fi

say_step "Claude Code hooks"
run "$MP" install-hooks

# Codex and Gemini CLI hooks, only for tools that are installed. A failure (e.g. a settings file
# that isn't plain JSON) is reported but doesn't stop the install.
if command -v codex >/dev/null 2>&1; then
  say_step "Codex hooks"
  run "$MP" install-hooks --target codex || echo "Codex hook install failed; continuing."
  echo "→ In Codex, run /hooks to trust them."
fi
if command -v gemini >/dev/null 2>&1; then
  say_step "Gemini CLI hooks"
  run "$MP" install-hooks --target gemini || echo "Gemini hook install failed; continuing."
fi

say_step "Background daemon (launchd)"
run mkdir -p "$HOME/.config/mouthpiece"
run "$MP" install-agent

say_step "Testing"
run sleep 1
run "$MP" say "Mouthpiece is ready."

cat <<EOF

Done. Next steps:
  • New Claude Code sessions will speak; type your next prompt to interrupt.
  • Hotkeys: ⌃⌥S stop · ⌃⌥N skip · ⌃⌥R replay · ⌃⌥M summary/full.
  • mouthpiece status | mode | usage — config: ~/.config/mouthpiece/config.toml
  • Update: git pull && ./install.sh — Remove: ./uninstall.sh
EOF
