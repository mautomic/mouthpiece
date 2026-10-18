#!/usr/bin/env bash
# uninstall.sh: remove Mouthpiece's agent, hooks, CLI link, and helper app. Asks before deleting data and keys.
set -euo pipefail

DRY_RUN="${MOUTHPIECE_DRY_RUN:-0}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
# MP is a shell-quoted command line: run() evals it, so paths with spaces stay intact.
MP="'$HOME/.local/bin/mouthpiece'"
[ -x "$HOME/.local/bin/mouthpiece" ] || MP="'$BUN' '$REPO/packages/cli/src/main.ts'"

run() { echo "+ $*"; if [ "$DRY_RUN" != 1 ]; then eval "$@"; fi; }
# A dry run answers yes to every question (run only prints then), so the plan shows every step.
ask() {
  if [ "$DRY_RUN" = 1 ]; then echo "? $1 (dry run: planning yes)"; return 0; fi
  [ -t 0 ] && { read -rp "$1 [y/N] " a; [ "$a" = y ] || [ "$a" = Y ]; }
}

run "$MP uninstall-agent"
# Each is idempotent ("No Mouthpiece hooks found." when there is nothing to remove).
run "$MP uninstall-hooks --target claude-code"
run "$MP uninstall-hooks --target codex || echo 'Could not update Codex hooks; continuing.'"
run "$MP uninstall-hooks --target gemini || echo 'Could not update Gemini hooks; continuing.'"
# Before the CLI link is removed: $MP may be that link.
if ask "Delete the Inworld key from Keychain?"; then run "$MP auth inworld --delete"; fi
run "rm -f '$HOME/.local/bin/mouthpiece' '$HOME/.mouthpiece/bin/mouthpiece-hotkeys'"
run "rm -rf '$HOME/.mouthpiece/MouthpieceHelper.app'"
if ask "Delete the Kokoro voice (~/.mouthpiece/kokoro, about 500 MB)?"; then
  run "rm -rf '$HOME/.mouthpiece/kokoro'"
fi
if ask "Delete ~/.mouthpiece (token, cache, usage history) and ~/.config/mouthpiece?"; then
  run "rm -rf '$HOME/.mouthpiece' '$HOME/.config/mouthpiece'"
fi
echo "Mouthpiece removed. The repo itself was left in place."
