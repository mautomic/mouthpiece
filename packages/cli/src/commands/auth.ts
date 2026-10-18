import { parseArgs } from "node:util";
import { deleteSecret, storeSecret } from "@mouthpiece/core";
import type { CommandFn } from "../types.ts";

export const authCommand: CommandFn = async (args, io, deps) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { delete: { type: "boolean", default: false } },
  });
  const [name] = positionals;
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    io.err(
      "usage: mouthpiece auth <provider> [--delete]   (e.g. pbpaste | mouthpiece auth inworld)\n",
    );
    return 2;
  }
  if (values.delete) {
    io.out(
      (await deleteSecret(name, deps.exec))
        ? `Removed ${name} key from Keychain.\n`
        : `No ${name} key in Keychain.\n`,
    );
    return 0;
  }
  if (io.stdinIsTTY) {
    io.err(`mouthpiece: pipe the key in, e.g. pbpaste | mouthpiece auth ${name}\n`);
    return 2;
  }
  const key = (await io.readStdin()).trim();
  if (!key) {
    io.err("mouthpiece: empty key\n");
    return 2;
  }
  await storeSecret(name, key, deps.exec);
  io.out(`Stored ${name} key in Keychain (service "mouthpiece"). Restart the daemon to use it.\n`);
  return 0;
};
