/** Test helpers for HTTP providers: canned bodies and a recording fetch. Never hits the network. */

export function streamOf(...parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(typeof p === "string" ? encode(p) : p);
      controller.close();
    },
  });
}

/** A body that sends `parts` and then stays open without sending anything else. */
export function stalledStreamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(encode(p));
    },
  });
}

/** A body that sends `parts` one per read and then errors. */
export function brokenStreamOf(...parts: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[index++];
      if (part === undefined) controller.error(new Error("connection reset"));
      else controller.enqueue(encode(part));
    },
  });
}

/** A fetch that records each request and answers with `respond(request)`. */
export function recordingFetch(
  respond: (req: Request) => Response | Promise<Response>,
  seen: Request[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req.clone());
    return respond(req);
  }) as unknown as typeof fetch;
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Live tests also need the provider's key; see each provider's test file. */
export const LIVE = process.env.MOUTHPIECE_LIVE_TESTS === "1";

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
