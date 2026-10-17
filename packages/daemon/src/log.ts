import type { Logger } from "@mouthpiece/core";

/** JSON lines on stderr. */
export const jsonLogger: Logger = (record) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), ...record }));
};
