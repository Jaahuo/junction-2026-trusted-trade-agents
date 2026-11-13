import type { Db } from "@app/server-kit";
import { desc } from "drizzle-orm";
import type { NoteRepository } from "../application/notes.ts";
import { notes } from "./schema.ts";

export const postgresNoteRepository = (db: Db): NoteRepository => ({
  save: async (note) => {
    await db.insert(notes).values(note);
  },
  list: async () => db.select().from(notes).orderBy(desc(notes.createdAt)),
});
