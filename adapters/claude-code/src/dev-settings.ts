// dev-settings.ts: prints a --settings JSON for trying the hooks without editing ~/.claude/settings.json.
// Usage: claude --settings "$(bun adapters/claude-code/src/dev-settings.ts)"
import { join } from "node:path";

const main = join(import.meta.dir, "main.ts");
const hook = (event: string) => ({
  type: "command",
  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(main)} ${event}`,
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
