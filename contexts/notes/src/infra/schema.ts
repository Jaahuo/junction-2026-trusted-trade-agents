import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import type { NoteId } from "../domain/note.ts";

export const notes = pgTable("notes_notes", {
  id: text().$type<NoteId>().primaryKey(),
  text: text().notNull(),
  createdAt: bigint({ mode: "number" }).notNull(),
});
