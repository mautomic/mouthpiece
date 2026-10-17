import { expect, test } from "bun:test";
import { collectChunks, singleChunk } from "./audio.ts";

test("singleChunk + collectChunks round-trip", async () => {
  expect(await collectChunks(singleChunk(new Uint8Array([1, 2, 3])))).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

test("collectChunks concatenates in order", async () => {
  async function* parts() {
    yield new Uint8Array([1]);
    yield new Uint8Array([2, 3]);
  }
  expect(await collectChunks(parts())).toEqual(new Uint8Array([1, 2, 3]));
});
