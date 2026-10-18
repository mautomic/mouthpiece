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

test("the most important results come first, and what the user must do or answer comes last", () => {
  const prompt = summaryPrompt(700, 1000);
  const results = prompt.indexOf("1. The most important things the assistant did");
  const userAction = prompt.indexOf("2. End with anything the user needs to do");
  expect(results).toBeGreaterThan(-1);
  expect(userAction).toBeGreaterThan(results);
  expect(prompt).toContain("most important first");
  expect(prompt).toContain("including any question");
  expect(prompt).toContain("Never leave out a question or something the user needs to do");
});

test("with nothing for the user to do, the summary just ends (no 'no action needed')", () => {
  expect(summaryPrompt(700, 1000)).toContain(
    "If there is nothing for the user to do or answer, just end",
  );
});
