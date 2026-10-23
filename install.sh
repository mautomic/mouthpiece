#!/usr/bin/env bash
# install.sh: set up Mouthpiece for this macOS user. Safe to re-run. MOUTHPIECE_DRY_RUN=1 prints the plan only.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${MOUTHPIECE_DRY_RUN:-0}"
# An explicit $BUN wins; otherwise a Bun on PATH (brew, mise, …); otherwise the default install path.
BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
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

# Comments only, so nothing is pinned against future defaults — and an existing config is never touched.
write_default_config() {
  local cfg="${MOUTHPIECE_CONFIG:-$HOME/.config/mouthpiece/config.toml}"
  echo "+ write default config to $cfg"
  if [ "$DRY_RUN" = 1 ]; then return; fi
  if [ -f "$cfg" ]; then
    echo "  (exists; left as-is)"
    return
  fi
  mkdir -p "$(dirname "$cfg")"
  cat > "$cfg" <<'TOML'
# Mouthpiece configuration. Every key is optional — this file is comments only, so the daemon
# runs on its defaults. The file hot-reloads on save. See README.md and docs/api.md for every
# option; delete this file to go back to all defaults.

# The provider chain: the first provider that can synthesize speaks; the rest are fallbacks.
# [provider]
# chain = ["kokoro", "say"]

# The local Kokoro voice (install with `mouthpiece kokoro install`; list voices with
# `mouthpiece voices --provider kokoro`):
# [provider.kokoro]
# voice = "af_heart"
# speed = 1.3   # 0.5 to 2

# A voice per project label, or per source (or edit these from the menubar's Settings menu):
# [voices.kokoro]
# my-project = "am_adam"
# [sourceVoices.kokoro]
# codex = "am_adam"

# Speech mode: "summary" | "full" | "off"
# [modes]
# default = "summary"
TOML
}

write_cli_wrapper() {
  echo "+ write CLI wrapper to $MP"
  if [ "$DRY_RUN" != 1 ]; then
    printf '#!/usr/bin/env bash\nexec "%s" --config="%s" --no-env-file "%s" "$@"\n' \
      "$BUN" "$REPO/bunfig.toml" "$REPO/packages/cli/src/main.ts" > "$MP"
    chmod +x "$MP"
  fi
}

[ "$(uname -s)" = Darwin ] || { echo "Mouthpiece requires macOS." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Mouthpiece requires Apple Silicon (arm64); Intel Macs are not supported." >&2; exit 1; }

say_step "Checking Bun"
if [ ! -x "$BUN" ]; then
  echo "Bun not found at $BUN."
  run bash -c 'curl -fsSL https://bun.sh/install | bash'
  if [ ! -x "$BUN" ] && [ "$DRY_RUN" != 1 ]; then
    echo "Bun is still not at $BUN. Install it (e.g. brew install oven-sh/bun/bun) or set BUN=/path/to/bun." >&2
    exit 1
  fi
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
  run "$BUN" install --frozen-lockfile
)

say_step "Linking the mouthpiece CLI into $BIN_DIR"
run mkdir -p "$BIN_DIR"
# Pin the repo's bunfig.toml and skip .env so a project's own bunfig.toml can't break the CLI.
write_cli_wrapper
# `--help` exits 2 by design, so capture its output instead of piping under pipefail.
if [ "$DRY_RUN" != 1 ]; then
  help_out="$("$MP" --help 2>&1 || true)"
  case "$help_out" in
    *"usage: mouthpiece"*) ;;
    *) echo "warning: $MP did not run as expected; try it directly to see the error." ;;
  esac
fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: add $BIN_DIR to your PATH." ;; esac
write_default_config

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
  HOOKED=0
  if command -v claude >/dev/null 2>&1; then
    say_step "Claude Code hooks"
    run "$MP" install-hooks || echo "Claude Code hook install failed; continuing."
    HOOKED=1
  fi
  if command -v codex >/dev/null 2>&1; then
    say_step "Codex hooks"
    run "$MP" install-hooks --target codex || echo "Codex hook install failed; continuing."
    echo "→ In Codex, run /hooks to trust them."
    HOOKED=1
  fi
  if command -v gemini >/dev/null 2>&1; then
    say_step "Gemini CLI hooks"
    run "$MP" install-hooks --target gemini || echo "Gemini hook install failed; continuing."
    HOOKED=1
  fi
  if command -v devin >/dev/null 2>&1; then
    say_step "Devin hooks"
    run "$MP" install-hooks --target devin || echo "Devin hook install failed; continuing."
    echo "→ In Devin, run /hooks to confirm they loaded."
    HOOKED=1
  fi
  if [ "$HOOKED" = 0 ]; then
    echo "No supported tools found on PATH (claude, codex, gemini, devin); no hooks installed."
  fi
fi

if [ "$WITH_AGENT" = 1 ]; then
  say_step "Background daemon (launchd)"
  run "$MP" install-agent || echo "Agent install failed; the daemon still runs with \`mouthpiece start\`."
fi

if [ "$WITH_AGENT" = 1 ]; then
  NEXT="The daemon is running through launchd and starts at login (manage: mouthpiece daemon start|stop|restart)."
else
  NEXT="Start the daemon with: mouthpiece start   (or install it as a login service: ./install.sh --with-agent)"
fi
cat <<EOF

Done. $NEXT
Optional integrations: rerun ./install.sh with --with-helper, --with-hooks, --with-agent, or --with-kokoro.
Config: ~/.config/mouthpiece/config.toml
EOF
