// fixture-main.ts: a minimal hook process for run.test.ts's silence tests.
import { runHook } from "./run.ts";

await runHook(async (_event, _input, ctx) => {
  await ctx.speak({ text: "fixture", source: "hook-kit-test" });
});
