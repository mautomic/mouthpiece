import { expect, test } from "bun:test";
import { AGENT_LABEL, agentPlist, launchAgentsDir } from "./launchd.ts";

test("plist runs `mouthpiece start` with PATH, env, logs, and restart-on-crash", () => {
  const xml = agentPlist({
    bun: "/u/.bun/bin/bun",
    cliMain: "/repo/packages/cli/src/main.ts",
    logPath: "/u/.mouthpiece/daemon.log",
    pathDirs: ["/u/.bun/bin", "/u/.local/bin", "/usr/bin", "/bin"],
    env: { MOUTHPIECE_PORT: "7400" },
  });
  expect(xml).toContain(`<string>${AGENT_LABEL}</string>`);
  expect(xml).toContain(
    "<string>/u/.bun/bin/bun</string>\n      <string>/repo/packages/cli/src/main.ts</string>\n      <string>start</string>",
  );
  expect(xml).toContain(
    "<key>PATH</key>\n      <string>/u/.bun/bin:/u/.local/bin:/usr/bin:/bin</string>",
  );
  expect(xml).toContain("<key>MOUTHPIECE_PORT</key>\n      <string>7400</string>");
  expect(xml).toContain("<key>SuccessfulExit</key>\n      <false/>");
  expect(xml).toContain(
    "<key>StandardErrorPath</key>\n    <string>/u/.mouthpiece/daemon.log</string>",
  );
});

test("escapes XML", () => {
  expect(
    agentPlist({ bun: "/a&b", cliMain: "/m", logPath: "/l", pathDirs: [], env: {} }),
  ).toContain("/a&amp;b");
});

test("launchAgentsDir override", () => {
  expect(launchAgentsDir({ MOUTHPIECE_LAUNCH_AGENTS_DIR: "/tmp/la" })).toBe("/tmp/la");
  expect(launchAgentsDir({})).toEndWith("/Library/LaunchAgents");
});
