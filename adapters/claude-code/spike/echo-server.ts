// Spike: records what an `http` hook sends. Usage: SPIKE_DIR=... bun echo-server.ts
const dir = process.env.SPIKE_DIR;
if (!dir) throw new Error("SPIKE_DIR is required");
Bun.serve({
  hostname: "127.0.0.1",
  port: 7399,
  async fetch(req) {
    const record = {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    };
    await Bun.write(`${dir}/http-${Date.now()}.json`, JSON.stringify(record, null, 2));
    return Response.json({});
  },
});
console.log("echo server on http://127.0.0.1:7399");
