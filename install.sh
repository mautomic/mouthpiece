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
run bash -c "cd '$REPO' && '$BUN' install"

say_step "Linking the mouthpiece CLI into $BIN_DIR"
run mkdir -p "$BIN_DIR"
# Pin the repo's bunfig.toml and skip .env so a project's own bunfig.toml can't break the CLI.
run bash -c "printf '#!/usr/bin/env bash\nexec \"%s\" --config=\"%s\" --no-env-file \"%s\" \"\$@\"\n' '$BUN' '$REPO/bunfig.toml' '$REPO/packages/cli/src/main.ts' > '$MP' && chmod +x '$MP'"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: add $BIN_DIR to your PATH." ;; esac

say_step "Building helper (hotkeys, menubar, mic pause)"
if command -v swiftc >/dev/null 2>&1; then
  run "$MP" build-helper || echo "Helper build failed; continuing without hotkeys, menubar or mic pause."
else
  echo "swiftc not found; skipping build-helper (install Xcode Command Line Tools to enable)."
fi

say_step "Local Kokoro voice (the default voice)"
# Installed unless you answer no; without a terminal it installs too. Until it is, macOS say speaks.
a=y
if [ -t 0 ] && [ "$DRY_RUN" != 1 ]; then
  read -rp "Install the free local Kokoro voice (~500 MB)? [Y/n] " a
fi
case "$a" in
  n|N|no|No|NO) echo "Skipped; macOS say speaks until you run: mouthpiece kokoro install" ;;
  *) run "$MP" kokoro install || echo "Kokoro install failed; continuing with macOS say." ;;
esac

say_step "TTS provider key (optional)"
if [ "$DRY_RUN" != 1 ] && [ -t 0 ]; then
  read -rsp "Inworld API key (optional; Enter to skip): " key; echo
  if [ -n "$key" ]; then printf '%s' "$key" | "$MP" auth inworld; fi
else
  echo "+ (skipped prompt) printf <key> | $MP auth inworld"
fi

say_step "Claude Code hooks"
run "$MP" install-hooks

# Codex, Gemini CLI and Devin hooks, only for tools that are installed. A failure (e.g. a settings file
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
if command -v devin >/dev/null 2>&1; then
  say_step "Devin hooks"
  run "$MP" install-hooks --target devin || echo "Devin hook install failed; continuing."
  echo "→ In Devin, run /hooks to confirm they loaded."
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
  • Hotkeys: ⌃⌥S stop · ⌃⌥N skip · ⌃⌥R replay · ⌃⌥M summary/full. The menubar icon shows what is playing.
  • Speech pauses while another app uses the microphone (e.g. dictation) and resumes where it stopped.
  • mouthpiece status | mode | usage — config: ~/.config/mouthpiece/config.toml
  • Update: git pull && ./install.sh — Remove: ./uninstall.sh
EOF
