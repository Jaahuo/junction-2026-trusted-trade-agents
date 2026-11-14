import { type Db, env } from "@app/server-kit";
import { addNote } from "../application/notes.ts";
import { postgresNoteRepository } from "../infra/note-repository.ts";

const demoNotes = [
  "Review the supplier's delivery schedule",
  "Confirm the order quantities with the buyer",
  "Follow up on substitute products",
  "Check the delivery confirmation",
];

export const seed = async (db: Db): Promise<void> => {
  if (env("NODE_ENV") === "production") return;

  const repository = postgresNoteRepository(db);
  const start = new Date("2026-11-01T16:00:00Z").getTime();
  for (const [index, text] of demoNotes.entries()) {
    await addNote(repository, text, new Date(start + index * 60_000));
  }
};
