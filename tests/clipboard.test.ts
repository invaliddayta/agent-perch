import { expect, test } from "bun:test";
import { clipboardParser } from "../server/clipboard";

test("clipboard writes survive chunking, UTF-8, and tmux duplicate passthrough", () => {
  const copies: string[] = [];
  const parse = clipboardParser((text) => copies.push(text));
  const text = "Clipboard \u2713 caf\u00e9";
  const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
  for (const character of sequence) parse(character);
  parse(`\x1bPtmux;\x1b${sequence}\x1b\\`);
  expect(copies).toEqual([text]);
  parse(`\x1b]52;;${Buffer.from("second").toString("base64")}\x1b\\`);
  expect(copies).toEqual([text, "second"]);
});

test("clipboard reads, clears, invalid data and oversized writes are ignored", () => {
  const copies: string[] = [];
  const parse = clipboardParser((text) => copies.push(text));
  for (const payload of [
    "c;?",
    "c;",
    "c;%%%",
    "p;aGVsbG8=",
    "c;/w==",
    "c;" + Buffer.alloc(128 * 1024 + 1).toString("base64"),
  ])
    parse(`\x1b]52;${payload}\x07`);
  parse("\x1b]52;c;" + "A".repeat(300 * 1024));
  parse("\x07plain output");
  expect(copies).toEqual([]);
  parse("\x1b]52;c;T0s=\x07");
  expect(copies).toEqual(["OK"]);
});
