import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "@mouthpiece/core";

export const AGENT_LABEL = "dev.mouthpiece.daemon";

export interface AgentSpec {
  bun: string;
  cliMain: string;
  logPath: string;
  pathDirs: string[];
  env: Record<string, string>;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function launchAgentsDir(env: Env): string {
  return env.MOUTHPIECE_LAUNCH_AGENTS_DIR || join(homedir(), "Library", "LaunchAgents");
}

/** The current user's launchd GUI domain, e.g. `gui/501`. */
export function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/** launchd user agent running `mouthpiece start`; restarted if it crashes (FR-12). */
export function agentPlist(spec: AgentSpec): string {
  const envEntries = { PATH: spec.pathDirs.join(":"), ...spec.env };
  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(spec.bun)}</string>
      <string>${esc(spec.cliMain)}</string>
      <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${esc(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${esc(spec.logPath)}</string>
  </dict>
</plist>
`;
}
