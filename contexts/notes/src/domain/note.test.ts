import { expect, test } from "bun:test";
import { createNote } from "./note.ts";

const now = new Date("2026-11-13T10:00:00Z");

test("trims the text of a new note", () => {
  expect(createNote("  hello  ", now)).toMatchObject({ ok: true, value: { text: "hello" } });
});

test("rejects an empty note", () => {
  expect(createNote("   ", now)).toEqual({ ok: false, error: "empty-text" });
});

test("rejects a note longer than 280 characters", () => {
  expect(createNote("x".repeat(281), now)).toEqual({ ok: false, error: "text-too-long" });
});
