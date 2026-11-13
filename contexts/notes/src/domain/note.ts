import { type Brand, err, newId, ok, type Result } from "@app/kernel";

export type NoteId = Brand<string, "NoteId">;

export interface Note {
  readonly id: NoteId;
  readonly text: string;
  readonly createdAt: number;
}

export type NoteError = "empty-text" | "text-too-long";

const maxLength = 280;

export const createNote = (text: string, now: Date): Result<Note, NoteError> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return err("empty-text");
  if (trimmed.length > maxLength) return err("text-too-long");
  return ok({ id: newId<"NoteId">(), text: trimmed, createdAt: now.getTime() });
};
