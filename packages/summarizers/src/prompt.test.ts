import { expect, test } from "bun:test";
import { summaryPrompt } from "./prompt.ts";

test("the prompt aims 60 characters under the limit, since replies run long", () => {
  expect(summaryPrompt(400)).toContain("at most 340 characters");
  expect(summaryPrompt(520)).toContain("at most 460 characters");
  expect(summaryPrompt(120)).toContain("at most 100 characters");
});

test("questions and what the user must do come before what happened, so trimming can't drop them", () => {
  const prompt = summaryPrompt(400);
  const question = prompt.indexOf("question or decision");
  const userAction = prompt.indexOf("anything the user needs to do");
  const happened = prompt.indexOf("what the assistant did");
  expect(question).toBeGreaterThan(-1);
  expect(userAction).toBeGreaterThan(question);
  expect(happened).toBeGreaterThan(userAction);
  expect(prompt).toContain("Never leave out");
});
