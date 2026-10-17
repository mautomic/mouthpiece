// dev-settings.ts: prints a --settings JSON for trying the hooks without editing ~/.claude/settings.json.
// Usage: claude --settings "$(bun adapters/claude-code/src/dev-settings.ts)"
import { join } from "node:path";

const main = join(import.meta.dir, "main.ts");
// Pin the repo's bunfig.toml and skip .env: hooks run with cwd at the user's project, whose own
// bunfig.toml could otherwise make them print or exit 1 (same as `mouthpiece install-hooks`).
const config = join(import.meta.dir, "..", "..", "..", "bunfig.toml");
const hook = (event: string) => ({
  type: "command",
  command: `${JSON.stringify(process.execPath)} --config=${JSON.stringify(config)} --no-env-file ${JSON.stringify(main)} ${event}`,
  async: true,
});

console.log(
  JSON.stringify({
    hooks: {
      Stop: [{ hooks: [hook("stop")] }],
      UserPromptSubmit: [{ hooks: [hook("prompt")] }],
      Notification: [{ matcher: "permission_prompt", hooks: [hook("notify")] }],
    },
  }),
);
