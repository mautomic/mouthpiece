// Test host for spawnPlayer: speaks the mouthpiece-player protocol over stdin and stdout. Every clip
// "plays" at once: its "end" is answered with "ending" and "done".
export {}; // a module, for the top-level for-await

const reply = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);
reply({ event: "ready" });
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const command = JSON.parse(buffer.slice(0, nl)) as { op: string; id?: number };
    buffer = buffer.slice(nl + 1);
    if (command.op === "end") {
      reply({ event: "ending", id: command.id });
      reply({ event: "done", id: command.id });
    }
  }
}
