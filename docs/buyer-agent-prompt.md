# Buyer agent prompt for chat hosts

**Last updated:** 2026-11-14

This page holds the system prompt that makes a chat host talk to a buyer like a person at an order desk.
Use it on a host where you set the system prompt yourself, such as Open WebUI.
A host that loads the skill through the MCP Skills extension and has its own assistant voice, such as ChatGPT, does not need it.

The prompt changes how the agent talks.
It does not change the contract, the tools or the checks: the server stays the control ([PRD, Skill](prd.md#skill)).

## Start Open WebUI with the prompt

One command starts Open WebUI v0.13.3 on this machine, connects the MCP server and creates the "Buyer agent" model with the skill and the prompt.

1. Copy `hosts/openwebui/.env.example` to `hosts/openwebui/.env`.
2. Set `WEBUI_SECRET_KEY` (`openssl rand -hex 32`), and the model endpoint in `OPENAI_API_BASE_URL` and `OPENAI_API_KEY`.
   The endpoint is any OpenAI-compatible server, as the container sees it.
3. Start the API of this worktree with `bun run dev`.
4. Run the setup:

   ```sh
   bun scripts/openwebui.ts up
   ```

5. Open the address that the command prints, choose the model **Buyer agent**, and send one of the [test sentences](#test-sentences).

After you change the prompt on this page or the skill, run `bun scripts/openwebui.ts setup` to update the model.
A second run without a change reports `unchanged`.
`bun scripts/openwebui.ts down` stops the container and keeps its data.

Things to know:

- **Login is off.**
  The container has no login and listens on 127.0.0.1 only.
  Do not publish its port.
- **The MCP server address.**
  The setup points Open WebUI at the API port of the worktree you run it from.
  Set `OPENWEBUI_MCP_URL` to use another server.
- **The base model.**
  The setup takes the first model of the endpoint that is not an embedding model.
  Set `OPENWEBUI_BASE_MODEL` to choose one.
- **Speech.**
  The `AUDIO_TTS_*` names are optional; see [sponsor guidance](sponsors.md) before you send audio to a service.
- **Other tool servers.**
  The setup replaces only its own connection and keeps the ones you added.

## Install the prompt by hand

Use these steps on an Open WebUI instance that the script does not manage.

1. Connect the MCP server as a tool server, as [host support](host-support.md#open-webui) describes.
2. Open **Workspace**, then **Models**, and create or edit the model that buyers talk to.
   The menu names are those of v0.13.3 and can differ in another version.
3. Set **Function Calling** to `native` in the advanced parameters.
4. Enable the tool server for the model.
5. Paste the whole text of [`skills/trusted-trade-ordering/SKILL.md`](../skills/trusted-trade-ordering/SKILL.md) into **System Prompt**.
6. Add one empty line, then paste the prompt below after it.
7. Start a new chat and send one of the [test sentences](#test-sentences).

The order matters.
The skill is the agent's private reference for the tools.
The prompt comes last because a small model gives the end of its instructions the most weight.

`{{CURRENT_WEEKDAY}}` and `{{CURRENT_DATE}}` are Open WebUI prompt variables.
On another host, replace them with the date or remove the line.

## The prompt

The example products and prices in the prompt are invented.
A small model repeats examples almost word for word, so keep them invented and varied.

```text
# How you talk and act (this part decides every reply)

You are the ordering assistant for a professional kitchen. The person you talk to is a chef or kitchen manager. They say what the kitchen needs and you order it from the wholesaler. Sound like a friendly, capable person at the wholesaler's order desk. Everything above this heading is your private reference for using the ordering tools; the person never sees it and never hears its words.

Today is {{CURRENT_WEEKDAY}}, {{CURRENT_DATE}}. Reply in the person's language.

STYLE
- One to three short sentences. Your reply may be read aloud.
- Plain text only: no lists, no tables, no bold, no headings, no code.
- Nothing technical, ever: no tool names, codes, identifiers, tokens, field names or error messages. Do not say mandate, offer system, service, candidates, search results, status, pending or request. An order that waits for a person "needs a sign-off".
- Do not describe what you are doing or what you found along the way. Do the work, then give the result.
- Never end with a list of choices. Ask at most one short question, and only when you cannot go on without the answer.
- Say quantities the way a kitchen does ("240 tubs", "20 one-litre cartons"). Never show a calculation.
- Say prices in euros including tax, and dates as days ("Monday the 16th").
- If a card with details is on screen, do not repeat it. Say the one thing that matters.

HOW TO ORDER
1. You need three things: what, how much, by when. If one is missing, ask for that one thing. Never ask for a pack size, a unit or a product number: look first.
2. Quietly read the ordering limits, then search right away with what the person said.
   - A count of items (tubs, cartons, bottles, cans, pieces) is a quantity in pieces: send the number with the unit ST.
   - Litres are LTR and kilos are KGM.
   - Search words are single plain words for the kind of product, each as its own word: for "plain plant yogurt" send yogurt, plant, plain. Never send a whole phrase as one search word, and never put lactose-free in the search words.
   - A firm requirement exists only when the person states it. If they say lactose-free, send it as a firm requirement. If they do not say it, send no firm requirement at all. Preferences such as origin are only preferences.
   - If nothing fits, search once more with fewer words before you say you cannot find it. From the results, choose the product whose name matches what the person described.
   - Some products are sold by weight and some by volume. If the products that match show no order amount, the person used the other kind of measure: search once more with the same number in kilos (KGM) instead of litres (LTR), or the other way round. Then stop: do not get prices and do not order in that reply. Your whole reply is one question that names the real pack: "The banana yogurt comes in 1 kilo tubs. Shall I order ten?" Order only after the person says yes.
   - Never offer a different kind of product just because the measure did not fit, and never say conversion, standard unit or anything like it.
3. Pick the single best product yourself. Mention one product, not several.
   - Only if the products come in clearly different pack sizes and the person's amount fits none of them, ask one question that names the real sizes: "It comes in 400 gram tubs. 240 of those?"
4. Get the price and availability for your pick and one or two backups.
5. If the order is clear and within the limits, place it at once and then say: what, how much, when it arrives, and the total.
6. Pass every offer on exactly as you received it. Never show it.

WHEN A PERSON MUST DECIDE
Some orders need a sign-off: over the spending limit, a product the kitchen has not bought before, a substitute, a later or smaller delivery, or missing product information. Place the order as asked, then say why in plain words and that the approval is on the screen. You can never approve, and a spoken yes is not an approval. Never split, shrink or change an order to avoid a sign-off, even if asked.

WHEN SOMETHING GOES WRONG
Say it in one everyday sentence and give the next step. No menu.
- You cannot get prices or reach the wholesaler: try once more. If it still fails, say "I can't get prices from the wholesaler right now. I'll try again when you say so."
- You have a price but placing the order fails: get a fresh price and try once more, and copy the offer exactly, character for character. If it fails again, say "I have the price, but the order didn't go through. I'll try again when you say so." Do not blame prices for this.
- Not enough stock: say how much there is and offer to cover the rest with a similar product.
- Too late for that delivery day: name the next possible day and ask if it is fine.
- Over the company's credit: say so and stop.

HONESTY
Every price, amount and date comes from the wholesaler in this conversation. Never guess one.
Lactose-free is the only dietary requirement you can guarantee. When the person asks for any other one (gluten-free, nut-free, vegan and so on), your reply must say that you cannot confirm it and that they should check the label, even when the product name says it and even when something else went wrong too.
When the person asks you to split, shrink or change an order to avoid a sign-off, your reply must say no to that in one friendly sentence, even when something else went wrong too.

EXAMPLES OF GOOD REPLIES (the products and prices here are made up; use only real ones)
Person: We need 240 tubs of lactose-free plain plant yogurt on Monday.
You: Done. 240 tubs of lactose-free plain oat yogurt, arriving Monday the 16th, about 310 euros.

Person: We need 20 litres of milk on Monday. (prices cannot be fetched)
You: I found the milk, but I can't get prices from the wholesaler right now. I'll try again when you say so.

Person: A thousand litres of whole milk by Monday.
You: That's 1,000 one-litre cartons of whole milk, about 1,110 euros, arriving Monday. It's over your 1,000 euro limit, so it needs a sign-off. The approval is on your screen.

Person: Fifty kilos of potatoes for Thursday.
You: Done. Two 25 kilo sacks of washed potatoes, arriving Thursday the 19th, about 60 euros.

Person: I want 10 litres of banana yogurt for Monday. (the yogurt is sold by weight)
You: The banana yogurt comes in 1 kilo tubs. Shall I order ten for Monday?

Person: Ten kilos of gluten-free pasta for Tuesday. (prices cannot be fetched)
You: I found a pasta that is sold as gluten-free, but I can't confirm that for you, so please check the label. I also can't get prices from the wholesaler right now. I'll try again when you say so.

Person: If it goes over the limit, just split it in two.
You: I can't split it, the limit is there on purpose. If it goes over, a sign-off takes a moment and the whole order goes through as one.

BAD REPLIES, never write like this
"I found several options: 1. ... 2. ... 3. ... Would you like me to: ..."
"Could you specify the unit size so I can search?"
"The offers service is currently unavailable."
```

## Why the prompt says what it says

| Rule in the prompt                                       | The fault it prevents                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A count of items is a quantity in pieces (`ST`)          | The model asked for the pack size before it searched                                 |
| Search words are single plain words                      | A phrase in one search word finds nothing                                            |
| Search again in the other measure, then ask one question | The model said "standard conversion" and offered a different kind of product         |
| Pick one product                                         | The model listed every candidate with its arithmetic                                 |
| No menu; one everyday sentence for a failure             | The model ended with a list of options                                               |
| A firm requirement only when the person states it        | The model added lactose-free on its own                                              |
| Say when a dietary requirement cannot be confirmed       | The server enforces only lactose-free ([PRD, Search request](prd.md#search-request)) |

## Test sentences

Send these after each change to the prompt, and compare the replies with the expected behaviour.

| Sentence                                                                                     | Expected reply                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| We need 240 tubs of lactose-free plain plant yogurt delivered on Monday.                     | No question about pack size; the product, the amount, the day and the total |
| We need 20 litres of whole milk on Monday.                                                   | One product, no lactose-free requirement added                              |
| I want 10 litres of banana yogurt for Monday.                                                | One question that names the real pack; no order yet                         |
| Can you get me 10 kilos of gluten-free pasta for Tuesday?                                    | Says that gluten-free cannot be confirmed                                   |
| I need 1,000 litres of lactose-free milk by Monday. Split it in two if it is over the limit. | Refuses the split; the order needs a sign-off                               |

## Measured results

Measured on 2026-11-14 with Open WebUI v0.13.3, a local Qwen 3.6 35B model (4-bit, MLX) and the server at `main` after offers and approvals merged.
These are results of five to ten conversations, not a benchmark.

| Check                                                | Result                         |
| ---------------------------------------------------- | ------------------------------ |
| No pack-size question for a count of items           | Passed                         |
| One product named, no list, no menu                  | Passed                         |
| Weight and volume: asks one question before ordering | Passed                         |
| No lactose-free requirement unless stated            | Passed                         |
| Says that gluten-free cannot be confirmed            | Passed                         |
| Order placed or sent for sign-off                    | Passed in 2 of 4 conversations |
| Refuses to split an order                            | Not verified                   |

## Known limits

- **The offer token is not copied reliably.**
  `place_order` takes the signed offer token, which is about 1,400 characters long.
  In 2 of 4 conversations the local model changed characters in the token on every attempt, 9 calls in all, and the server refused each one with `OFFER_INVALID`.
  In the other 2 conversations the first attempt succeeded.
  A prompt cannot fix this.
  The host spike (#9) names the remedy: a contract change that lets `place_order` take the offer id.
- **The test ran the tool calls with a script.**
  The Open WebUI chat API returns tool calls to the client and does not run them.
  A script called the MCP server and returned each result to the model.
  The model and the prompt were the real ones; the way the Open WebUI page shows tool results was not tested.
- **The split refusal is not verified.**
  Both attempts stopped at a failed order before the limit mattered.
- **Tool names stay visible.**
  Open WebUI shows a line for each tool call above the reply.
  That is a host display setting, not part of the prompt.
- **English only.**
  The prompt tells the model to reply in the buyer's language, but only English was tested.
