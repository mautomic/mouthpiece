import { expect, test } from "bun:test";
import { approvalText } from "./alerts.ts";

test("approvalText names the tool when there is one", () => {
  expect(approvalText("web", "Bash")).toBe("web needs your approval to use Bash.");
});

test.each([[undefined], [null], [""]])("approvalText without a tool (%p)", (tool) => {
  expect(approvalText("web", tool)).toBe("web needs your approval.");
});
