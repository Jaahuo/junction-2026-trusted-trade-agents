import { type ContextModule, type Db, env } from "@app/server-kit";
import { Elysia, t } from "elysia";
import { addNote, listNotes, type Summarizer, summarizeNotes } from "../application/notes.ts";
import { createSummarizer } from "../infra/claude-summarizer.ts";
import { postgresNoteRepository } from "../infra/note-repository.ts";
import { seed } from "./seed.ts";

const summaryStatus = {
  "no-notes": 400,
  "summarizer-not-configured": 503,
  "summarizer-failed": 502,
} as const;

export const createApi = (
  db: Db,
  summarizer: Summarizer = createSummarizer(env("ANTHROPIC_API_KEY")),
) => {
  const repository = postgresNoteRepository(db);
  return new Elysia({ prefix: "/notes" })
    .get("/", () => listNotes(repository))
    .post("/", { body: t.Object({ text: t.String() }) }, async ({ body, status }) => {
      const result = await addNote(repository, body.text, new Date());
      return result.ok ? result.value : status(400, { error: result.error });
    })
    .post("/summary", async ({ status }) => {
      const result = await summarizeNotes(repository, summarizer);
      return result.ok
        ? { summary: result.value }
        : status(summaryStatus[result.error], { error: result.error });
    });
};

export type Api = ReturnType<typeof createApi>;

export const context: ContextModule = { name: "notes", api: createApi, seed };
