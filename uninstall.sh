#!/usr/bin/env bash
# uninstall.sh: remove Mouthpiece's agent, hooks, CLI link, and helper app. Asks before deleting data and keys.
set -euo pipefail

DRY_RUN="${MOUTHPIECE_DRY_RUN:-0}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# An explicit $BUN wins; otherwise a Bun on PATH; otherwise the default install path.
BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
MP="$HOME/.local/bin/mouthpiece"

run() { printf '+ '; printf '%q ' "$@"; printf '\n'; if [ "$DRY_RUN" != 1 ]; then "$@"; fi; }
mp() {
  if [ -x "$MP" ]; then
    run "$MP" "$@"
  elif [ -x "$BUN" ]; then
    # Same pins as the installed wrapper: a cwd's own bunfig.toml or .env must not reach the CLI.
    run "$BUN" --config="$REPO/bunfig.toml" --no-env-file "$REPO/packages/cli/src/main.ts" "$@"
  else
    echo "mouthpiece CLI and Bun are both gone; skipping: $*"
  fi
}
# A dry run answers yes to every question (run only prints then), so the plan shows every step.
ask() {
  if [ "$DRY_RUN" = 1 ]; then echo "? $1 (dry run: planning yes)"; return 0; fi
  [ -t 0 ] && { read -rp "$1 [y/N] " a; [ "$a" = y ] || [ "$a" = Y ]; }
}

mp uninstall-agent
# Each is idempotent ("No Mouthpiece hooks found." when there is nothing to remove).
mp uninstall-hooks --target claude-code || echo "Could not update Claude Code hooks; continuing."
mp uninstall-hooks --target codex || echo "Could not update Codex hooks; continuing."
mp uninstall-hooks --target gemini || echo "Could not update Gemini hooks; continuing."
mp uninstall-hooks --target devin || echo "Could not update Devin hooks; continuing."
# Before the CLI link is removed: $MP may be that link.
if ask "Delete the Inworld key from Keychain?"; then mp auth inworld --delete; fi
run rm -f "$HOME/.local/bin/mouthpiece" "$HOME/.mouthpiece/bin/mouthpiece-hotkeys"
run rm -rf "$HOME/.mouthpiece/MouthpieceHelper.app"
if ask "Delete the Kokoro voice (~/.mouthpiece/kokoro, about 500 MB)?"; then
  run rm -rf "$HOME/.mouthpiece/kokoro"
fi
if ask "Delete ~/.mouthpiece (token, cache, usage history) and ~/.config/mouthpiece?"; then
  run rm -rf "$HOME/.mouthpiece" "$HOME/.config/mouthpiece"
fi
echo "Mouthpiece removed. The repo itself was left in place."
