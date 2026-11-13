import { err, type Result } from "@app/kernel";
import { createNote, type Note, type NoteError } from "../domain/note.ts";

export interface NoteRepository {
  save(note: Note): Promise<void>;
  list(): Promise<readonly Note[]>;
}

export type SummaryError = "no-notes" | "summarizer-not-configured" | "summarizer-failed";

export interface Summarizer {
  summarize(texts: readonly string[]): Promise<Result<string, SummaryError>>;
}

export const addNote = async (
  repository: NoteRepository,
  text: string,
  now: Date,
): Promise<Result<Note, NoteError>> => {
  const result = createNote(text, now);
  if (result.ok) await repository.save(result.value);
  return result;
};

export const listNotes = (repository: NoteRepository): Promise<readonly Note[]> =>
  repository.list();

export const summarizeNotes = async (
  repository: NoteRepository,
  summarizer: Summarizer,
): Promise<Result<string, SummaryError>> => {
  const notes = await repository.list();
  if (notes.length === 0) return err("no-notes");
  return summarizer.summarize(notes.map((note) => note.text));
};
