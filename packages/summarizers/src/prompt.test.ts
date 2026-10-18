import { expect, test } from "bun:test";
import { summaryPrompt, summaryTarget } from "./prompt.ts";

test("the target is about 40% of the message, at least 200, and 60 under the limit", () => {
  expect(summaryTarget(700, 400)).toBe(200); // a short reply gets the floor, not the limit
  expect(summaryTarget(700, 1000)).toBe(400);
  expect(summaryTarget(700, 5000)).toBe(640);
  expect(summaryTarget(250, 1000)).toBe(190); // the limit wins over the floor
  expect(summaryTarget(120, 1000)).toBe(100);
  expect(summaryPrompt(700, 1000)).toContain("Aim for about 400 characters, never more.");
});

test("questions and what the user must do come before what happened, so trimming can't drop them", () => {
  const prompt = summaryPrompt(700, 1000);
  const question = prompt.indexOf("1. Any question or decision");
  const userAction = prompt.indexOf("2. Anything the user needs to do");
  const happened = prompt.indexOf("3. What the assistant did");
  expect(question).toBeGreaterThan(-1);
  expect(userAction).toBeGreaterThan(question);
  expect(happened).toBeGreaterThan(userAction);
  expect(prompt).toContain("Never leave out");
});
