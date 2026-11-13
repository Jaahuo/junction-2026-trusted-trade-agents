import type { Db } from "@app/server-kit";
import { addNote } from "../application/notes.ts";
import { postgresNoteRepository } from "../infra/note-repository.ts";

const demoNotes = [
  "Kickoff at 18:00, challenge briefs are in the main hall",
  "Talk to the partner mentor before choosing the challenge",
  "Record a demo video as soon as the main flow works",
  "Feature freeze four hours before the submission deadline",
];

export const seed = async (db: Db): Promise<void> => {
  const repository = postgresNoteRepository(db);
  const start = new Date("2026-11-01T16:00:00Z").getTime();
  for (const [index, text] of demoNotes.entries()) {
    await addNote(repository, text, new Date(start + index * 60_000));
  }
};
