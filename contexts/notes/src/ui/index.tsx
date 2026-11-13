import {
  Alert,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Spinner,
  toast,
} from "@app/ui";
import { apiUrl, type Screen } from "@app/web-kit";
import { treaty } from "@elysia/eden";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Api } from "../api/index.ts";

const api = treaty<Api>(apiUrl);
const queryKey = ["notes"];

const messages: Record<string, string> = {
  "empty-text": "Write something first.",
  "text-too-long": "A note can have at most 280 characters.",
  "no-notes": "Add a note before asking for a summary.",
  "summarizer-not-configured": "Set ANTHROPIC_API_KEY in .env to enable summaries.",
  "summarizer-failed": "The summary service did not answer. Try again.",
};
const explain = (code: string): string => messages[code] ?? "Something went wrong.";

function NotesScreen() {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const notes = useQuery({
    queryKey,
    queryFn: async () => (await api.notes.get()).data ?? [],
  });
  const add = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await api.notes.post({ text: value });
      if (error) throw new Error(error.status === 400 ? error.value.error : "invalid");
    },
    onSuccess: async () => {
      setText("");
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const summary = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.notes.summary.post();
      if (error) throw new Error(error.value.error);
      return data.summary;
    },
    onError: (error) => toast.error(explain(error.message)),
  });

  return (
    <>
      <PageHeader
        title="Notes"
        description="The reference context. Copy its shape for your own."
        actions={
          <Button
            variant="secondary"
            loading={summary.isPending}
            onClick={() => {
              summary.mutate();
            }}
          >
            Summarize
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {summary.data === undefined ? null : (
          <Alert tone="info" title="Summary">
            {summary.data}
          </Alert>
        )}
        <Card>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate(text);
            }}
          >
            <div className="flex-1">
              <Field label="New note" error={add.error ? explain(add.error.message) : undefined}>
                <Input
                  placeholder="Write a note"
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                  }}
                />
              </Field>
            </div>
            <Button type="submit" loading={add.isPending}>
              Add
            </Button>
          </form>
        </Card>
        <Card>
          <CardTitle>All notes</CardTitle>
          {notes.isPending ? <Spinner /> : null}
          {notes.data?.length === 0 ? (
            <EmptyState title="No notes yet" description="Add the first one above." />
          ) : (
            <ul className="divide-y divide-border">
              {notes.data?.map((note) => (
                <li key={note.id} className="py-2.5">
                  {note.text}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export const screen: Screen = { path: "/notes", title: "Notes", Component: NotesScreen };
