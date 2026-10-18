import type { Env } from "./home.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  cmd: string[],
  opts?: { stdin?: string; cwd?: string; env?: Env; timeoutMs?: number },
) => Promise<ExecResult>;

export const defaultExec: Exec = async (cmd, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
      env: opts.env as Record<string, string> | undefined,
      timeout: opts.timeoutMs,
    });
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};
