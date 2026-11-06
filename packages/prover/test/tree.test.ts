import { describe, expect, it } from "vitest";
import { toHex } from "viem";
import { createNote, noteToString, parseNote } from "../src/note";
import { ZEROS, pathFor } from "../src/tree";

// Pins MiMCSponge + ZERO_VALUE to the devnet pool: roots(0) and zeros(0).
describe("tree", () => {
  it("empty-tree root and zeros(0) match the pool", () => {
    expect(toHex(ZEROS[20], { size: 32 })).toBe("0x29d7ed391256ccc3ea596c86e933b89ff339d25ea8ddced975ae2fe30b5296d4");
    expect(toHex(ZEROS[0], { size: 32 })).toBe("0x2fe54c60d3acabf3343a35b6eba15db4821b340f76e741e2249685ed4899af6c");
  });

  it("path for a lone leaf is the zero ladder", () => {
    const p = pathFor([1n], 0);
    expect(p.pathElements).toEqual(ZEROS.slice(0, 20));
    expect(p.pathIndices.every((i) => i === 0)).toBe(true);
  });
});

describe("note", () => {
  it("round-trips through the tornado string format", () => {
    const n = createNote();
    expect(noteToString(n)).toMatch(/^0x[0-9a-f]{124}$/);
    expect(parseNote(noteToString(n))).toEqual(n);
  });
});
