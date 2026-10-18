// Test host: speaks the kokoro-host protocol with a fake engine, so tests don't need kokoro-js.
// The reply's "WAV" is `<pid>|<voice>|<text>|<n>|<speed>`, where n counts the requests this host received,
// so a test can tell hosts apart. Special texts: "error" replies with an error, "crash" throws (the
// host dies), "exit" writes a line to stderr and exits 3, "hang…" never replies, "noisy" writes to stdout and stderr first, "slow…" replies after
// 50 ms, and "block…" busy-waits 300 ms (a synchronous render). Homes: "fail-load" fails the engine
// load, "hang-load" never loads, "ignore-term" ignores SIGTERM.
import type { KokoroHostData, KokoroHostReply, KokoroHostRequest } from "./kokoro-process.ts";

const data = JSON.parse(process.argv[2] ?? "{}") as KokoroHostData;
const reply = (message: KokoroHostReply) => process.send?.(message);

if (data.home === "ignore-term") process.on("SIGTERM", () => {});
if (data.home === "fail-load") reply({ loadError: "model missing" });
else if (data.home !== "hang-load") reply({ ready: true });

let received = 0;
process.on("message", (message) => {
  const { id, text, voice, speed } = message as KokoroHostRequest;
  const n = ++received;
  const wav = () => new TextEncoder().encode(`${process.pid}|${voice}|${text}|${n}|${speed ?? ""}`);
  if (text.startsWith("hang")) return;
  if (text === "crash") throw new Error("engine crashed");
  if (text === "exit") {
    console.error("fatal: the renderer gave up");
    process.exit(3);
  }
  if (text === "error") return reply({ id, error: "generate failed" });
  if (text === "noisy") {
    console.log("phonemizer says hi on stdout");
    console.error("Error: phonemizer\n    at phonemize (fake.js:1:1)");
  }
  if (text.startsWith("block")) {
    const end = Date.now() + 300;
    while (Date.now() < end) {} // blocks the host's event loop, like a real render
  }
  if (text.startsWith("slow")) {
    setTimeout(() => reply({ id, wav: wav() }), 50);
    return;
  }
  reply({ id, wav: wav() });
});
