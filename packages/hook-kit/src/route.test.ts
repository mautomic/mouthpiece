import { expect, test } from "bun:test";
import { replyRoute } from "./route.ts";

const handle = "term_148202cb-9a23-4308-8380-a4efd3957057";

test("an Orca terminal handle becomes a reply route", () => {
  expect(replyRoute({ ORCA_TERMINAL_HANDLE: handle }, "claude")).toEqual({
    via: "orca",
    target: handle,
    agent: "claude",
  });
});

test("no handle, or a malformed one, means no route", () => {
  expect(replyRoute({}, "claude")).toBeUndefined();
  expect(replyRoute({ ORCA_TERMINAL_HANDLE: "" }, "claude")).toBeUndefined();
  expect(replyRoute({ ORCA_TERMINAL_HANDLE: "term_x; ls" }, "claude")).toBeUndefined();
});
