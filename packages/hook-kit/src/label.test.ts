import { expect, test } from "bun:test";
import { labelFromCwd } from "./label.ts";

test("labelFromCwd returns the directory's basename", () => {
  expect(labelFromCwd("/Users/me/code/projects/web")).toBe("web");
  expect(labelFromCwd("/x/web/")).toBe("web");
});

test.each([[undefined], [null], [42], [""], ["/"]])("labelFromCwd(%p) is undefined", (cwd) => {
  expect(labelFromCwd(cwd)).toBeUndefined();
});
