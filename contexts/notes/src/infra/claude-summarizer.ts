import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { err, ok } from "@app/kernel";
import type { Summarizer } from "../application/notes.ts";

export const createSummarizer = (apiKey: string | undefined): Summarizer => {
  if (apiKey === undefined) {
    return { summarize: async () => err("summarizer-not-configured") };
  }
  const client = new Anthropic({ apiKey });
  return {
    summarize: async (texts) => {
      try {
        const response = await client.beta.messages.create({
          model: "claude-opus-5-5",
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low" },
          system:
            "Summarize the user's notes in at most two sentences. Reply with the summary only.",
          messages: [{ role: "user", content: texts.map((text) => `- ${text}`).join("\n") }],
        });
        if (response.stop_reason === "refusal") return err("summarizer-failed");
        const summary = response.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("")
          .trim();
        return summary === "" ? err("summarizer-failed") : ok(summary);
      } catch (error) {
        if (error instanceof APIError) {
          console.error(`claude api error ${error.status}: ${error.message}`);
          return err("summarizer-failed");
        }
        throw error;
      }
    },
  };
};
