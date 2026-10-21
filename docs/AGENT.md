# Woshi, the booking assistant

A round mascot at the bottom right of the customer website and the Android app. It greets the customer in a small speech bubble; tapping it opens a chat (about 70% of the screen: a sheet on a phone, a box beside the page on a computer). The customer can book a single wash, start a membership, add a vehicle or an address, and ask about prices, in English, Hindi, Marathi or Hinglish. When the booking is ready the chat shows a card with the exact price and the same slide-to-pay the booking pages use. Once the payment is verified, the booking exists in the database and shows on the dashboard, exactly as if it had been made on the booking pages.

It runs on **free language-model services** (Google Gemini first, then Groq and OpenRouter if you add their keys). No paid key is needed. See "Switching it on" for what that means in practice.

**Status: built and tested against a stand-in model and a stand-in for the network; a first real ping of Gemini 3.5 Flash-Lite worked (it called the price tool and used the answer), but it was slow (20 to 35 seconds a call at the time), and `gemini-3.8-flash` timed out.** The full red team has not been run. See "Before you switch it on". If no model can be reached, **simple mode** (below) keeps booking working with no model at all.

## How it works

```
customer ──words──▶ website/app ──▶ POST /api/agent/chat ──▶ server
                                                              │ 1. checks the words (guards.ts) and the customer's limits
                                                              │ 2. asks the model (openai.ts: Gemini, else Groq, else OpenRouter), with the
                                                              │    standing instructions and 8 tools
                                                              │ 3. runs the tools the model asks for (tools.ts), as THIS customer
                                                              │ 4. checks what the model wrote (guards.ts) before anyone sees it
customer ◀─text + cards──────────────────────────────────────┘
customer taps Save / slides to pay ──▶ the SAME API calls the booking pages use (/vehicles, /payments/on-demand, /payments/membership-checkout, /payments/verify)
customer's screen ──"I paid"──▶ POST /api/agent/event ──▶ the server looks the booking up in the database and writes the confirmation itself
```

Files: `backend/src/agent/` (`guards.ts`, `prompt.ts`, `tools.ts`, `run.ts`, `store.ts`, `llm.ts`, `openai.ts`, `rules.ts`, `types.ts`), `backend/src/routes/agent.ts`; website `src/components/agent/`, `src/lib/agent.ts`; app `src/features/agent/`.

**The model is swappable.** `llm.ts` defines one small neutral shape (text, tool calls, tool answers). `openai.ts` translates it to the "chat completions" API that Gemini, Groq, OpenRouter, Mistral, Cerebras and a model on your own computer (Ollama) all offer. A service is just an address, a key and a model name. Several can be listed: when one is out of free allowance (429), down or refusing its key, the next one answers, and the first is left alone for a while.

The eight tools: `get_catalog`, `get_availability`, `quote_membership` (read only); `propose_vehicle`, `propose_address`, `propose_single_wash`, `propose_membership` (each only makes a card); `show_quick_replies`. There is no tool that runs a query, writes, charges, cancels or names a customer. The customer's vehicles and addresses are not fetched by tools: the server writes them into the model's context every message.

**The model never sees a database id.** Vehicles are `V1, V2…`, addresses `A1, A2…`, services `S1, S2…`; the server turns a handle back into the real id and still checks that it belongs to this customer. A model cannot invent or mangle an id that works.

**The model is shown as little personal detail as possible** (free services may keep and learn from what they are sent): the first name, the make and model of each vehicle, only the last four characters of a registration number, and for an address only the label, society and parking spot, never the block or flat number. The customer types the registration number and the flat on the card (a form on their own screen), not in the chat.

## Simple mode: booking with no model at all

When no language model can be reached, Woshi does not stop and does not show an error. It switches, for that customer's chat, to **simple mode** (`backend/src/agent/rules.ts`): fixed questions and tappable answers, in plain code. It switches when:

- every service is out of free allowance, down, too slow (a single call gives up after 25 seconds), or refusing its key, or
- the model is *answering*, but slowly: when one message takes longer than 20 seconds (`AGENT_SLOW_TURN_MS`), simple mode answers everybody for the next 5 minutes (`AGENT_SLOW_REST_MS`), then the model gets another go. The customer who waited still gets the model's answer. This matters: free Gemini models were measured at 20 to 37 seconds a call, so at those speeds Woshi mostly runs in simple mode, which is instant, and the model only takes the free-text questions when Google is quick, or
- no key is set at all (the assistant is still offered), or
- `AGENT_MODE=rules` forces it (never calls a model, even with keys).

What it does, in order: it says once "my smart replies are unavailable right now, so I'll guide you step by step", then offers **Book a single wash / Start a membership / Add a vehicle / Prices / How does it work? / Contact WASHO**. A single wash asks vehicle (if more than one), service (with the rate-card price), day, time window. A membership asks washes a month (4 to 28), Deep cleans (not for a bike), weekdays (as many as the washes need, typed or tapped), length (with the discount), window. If there is no vehicle or no address it asks the type and make and model, or the society, shows the same card as the model would, the customer types the registration number or flat on the card and saves it, and the booking carries on. It ends at the same server-built card with the exact price and the slide to pay; confirmation after payment is the same server-written message. "Change the time" and "Try again" after a closed payment work. Prices, answers about it, and contact details are fixed sentences plus numbers from the rate card.

It is **as safe as model mode, by construction**: it uses the same tools (the same rules about days, windows, plans, closed days and prices, the same handles, the same row-level security), the same input guard, the same limits, and the same cards. It never repeats what the customer typed (typed text only reaches a card for the customer to check), and an answer it does not understand just repeats the question with its buttons. It understands English words and numbers, not Hindi or Marathi, and it does not take coupons (the Book and Plans screens do).

**Buttons first (the default).** The buttons Woshi shows (Book a single wash, Start a membership, Add a vehicle, Prices, How does it work?, Contact WASHO, Book another wash) are answered by these fixed rules **without calling a model**: instant, and it spares the small free allowance. A booking started on the buttons is carried by the rules to the end. The model is used for what the rules cannot follow: a typed sentence ("I'd like to wash my Swift on Friday", questions, Hindi or Marathi). In the middle of a booking, words the rules do not follow never throw the customer out of it: the question is asked again with its buttons ("Start over" leaves it). The rules read typos ("vehichle", "sinlge"), type a vehicle in words ("chetak" means a bike; "type bike model chetak" gives the card at once), and offer common makes and models as buttons. A short typed command (up to four words that mean something on the menu, like "add vehicle" or "prices please") is answered by the rules too; a longer sentence between bookings goes to the model. `AGENT_RULES_FIRST=false` sends the buttons to the model too. Why: measured on 20 October 2026, free Gemini 3.x calls took 15 to 37 seconds (even a four-word answer took 15 to 19 seconds, while a bare round trip to Google took 0.3 seconds), so a chat that needs a model call for every tap would be unusable.

When the model is back: simple mode stays on for a booking already in progress; between bookings (and after `AGENT_RETRY_MODEL_MS`, default 3 minutes), the next message tries the model again. A customer who starts a new chat also tries the model first.

## The security model

**The model can never move money or write data.** It can only read the signed-in customer's own information and ask for a card to be shown. Saving a vehicle is the customer's tap on the card; paying is the customer's slide. Both go through the existing API calls, which check everything again (price from the rate card, availability, ownership, the Razorpay signature). The confirmation after payment is written by the server from the database, never by the model.

A smaller free model is easier to fool than a large paid one, so **nothing important depends on the model behaving**: the guards are plain code before and after it, and the worst a fooled model can do is write a sentence that the output guard then withholds.

**Every situation, what stops it, and the test that proves it** (`backend/tests/agent-guards.test.ts` for the plain-code guards, `backend/tests/api-agent.test.ts` for the whole server against a real database, `backend/tests/agent-openai.test.ts` for the connection to the services):

| Situation | What stops it |
|---|---|
| "Give me all the Supabase data", keys, tokens, the database, SQL, other customers' details, how the assistant is built | Refused in plain code before the model is called (about 55 attack phrasings, including spaced-out letters, leet-speak, full-width and Cyrillic look-alikes, hidden characters, other languages). Even if it got through, no tool can read another customer or run a query. |
| "Ignore your instructions", "you are now…", "developer mode", claiming to be the owner or an admin, asking to print the instructions | Same plain-code refusal; the standing instructions also tell the model to ignore such requests; the model's answer is checked for the hidden word and for nine-word runs of the instructions (one rewrite, then a standard message), and a leak of the hidden word ends the chat |
| Fake tags in a message (`</customer_message><server_context>…`) | The customer's words go between their own tag with `<` and `>` turned into text, so a customer cannot type a tag of ours |
| The screen sending a fake earlier "assistant" message, tool answer or card | The server keeps the whole conversation; the screen can only send the customer's new words (tested: extra fields are ignored) |
| A sentence stored in a vehicle's name or an address ("ignore previous instructions…") read back by the model | Everything a customer once typed is cleaned and, if it looks like an attack, replaced by `[hidden]` before the model reads it |
| Another customer's vehicle or address | The model can only name `V#`/`A#` handles built from this customer's own rows each message; a raw id, or a handle that is not in the list, is refused. Tools also run through the customer's own database session, so another customer's rows do not exist for it. |
| Strange tool names, extra fields, wrong types, absurd numbers, tool arguments that are not valid JSON (small models do this) | Every tool input is checked with a strict schema; refused with a plain reason, never run |
| A made-up price, discount or percentage | Only amounts and percentages that a tool returned in this chat may appear in an answer; otherwise the answer is withheld and the model is asked once to rewrite it from the tools. The card's numbers come from the database anyway, and the real charge is set by the database at payment. |
| "Your wash is booked", "payment received", "I've saved your vehicle" said by the model | Withheld (and rewritten once): only the server says it, after reading the database |
| A key (JWT, Razorpay, Google, Groq, OpenRouter and similar), connection string, someone's phone number or email, a foreign link in an answer | Blocked; the chat is wiped. Numbers in Devanagari or Arabic digits count too. Nothing secret is ever put in front of the model in the first place (tested). |
| A free model that "thinks out loud" | `<think>…</think>` text is stripped before anything else sees it |
| Spending the free allowance: floods, long chats, loops | 15 typed messages per 5 minutes and 60 a day per customer (when a customer has used these up, or the whole day's cap is reached, the fixed buttons still answer, so they are never sent away; the buttons have their own, larger limit of 100 per 5 minutes and 1500 a day), a daily token budget per customer, a global daily call cap, 600 characters per message, 40 messages per chat, 7 model calls per message, refused messages count too, one answer at a time per customer; older tool answers are shortened so each call stays small |
| Using it as a free general chatbot | The instructions limit it to WASHO bookings; the short answer limit and the limits above bound the use |
| Someone else confirming a payment | "I paid" is only believed after the server finds that booking for this customer (tested with another customer's booking) |
| The same card used twice | A used card is marked on the server and on the screen; the database also refuses a second wash for the same vehicle and day |
| A staff member's session | Only customers can use it (admins and specialists get "not allowed") |
| A free service out of allowance, down, too slow, or refusing its key | The next service (or the next Gemini model) answers; if none can, simple mode (above) carries on with the booking, and the failed turn leaves nothing behind in the model's history. The customer is never told which service or why. |
| Reading the conversation later | It lives only in the server's memory for 45 idle minutes; logs hold a short hash of the customer, which service answered, the tool names and token counts, never the words |

## Switching it on

The assistant is offered whenever `AGENT_ENABLED` is not `false`. With no key it answers in **simple mode** (no model); with a key it uses the model and falls back to simple mode when no model can be reached.

**You need only one key to start: `GEMINI_API_KEY`.** The other two are fallbacks.

1. **Google Gemini (first choice).** Open <https://aistudio.google.com/apikey>, sign in with a Google account, press "Create API key" (no card needed for the free tier). In Render → your web service → Environment, add `GEMINI_API_KEY`.
2. **Groq (optional fallback).** <https://console.groq.com/keys> → Create API Key. Add `GROQ_API_KEY`.
3. **OpenRouter (optional fallback).** <https://openrouter.ai/keys> → Create Key. Add `OPENROUTER_API_KEY`.

Then redeploy (Render restarts the service when an environment variable changes). Services are tried in the order Gemini, Groq, OpenRouter, for whichever have a key.

To see which model names a key can use (replace the key; do not paste it anywhere public):

```bash
curl -s -H "Authorization: Bearer $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/openai/models
```

Optional settings (all have defaults, set them only to change something):

| Variable | Default | What it does |
|---|---|---|
| `AGENT_ENABLED` | on | `false` switches the assistant off entirely (no mascot) without removing a key |
| `AGENT_RULES_FIRST` | on | Buttons are answered by the fixed rules with no model call; `false` sends them to the model as well |
| `AGENT_MODE` | auto | `rules` never calls a model: simple mode only (for example while free allowances are used up, or to run at zero cost) |
| `AGENT_SLOW_TURN_MS` / `AGENT_SLOW_REST_MS` | 20000 / 300000 | A message that takes longer than this many milliseconds puts everyone in simple mode for the rest period; `AGENT_SLOW_TURN_MS=0` turns the check off |
| `AGENT_RULES_PER_5_MIN` / `AGENT_RULES_PER_DAY` | 100 / 1500 | The separate, larger limit for messages answered by the fixed rules (they spend no model allowance) |
| `AGENT_RETRY_MODEL_MS` | 180000 | How long simple mode lasts after a model failed, before the next free moment between bookings tries the model again |
| `AGENT_PROVIDERS` | all with a key | The order to try them in, for example `gemini,groq` or `groq,gemini` |
| `GEMINI_MODEL` / `GROQ_MODEL` / `OPENROUTER_MODEL` | `gemini-3.5-flash-lite,gemini-3.8-flash` / `openai/gpt-oss-120b` / `openrouter/free` | The model(s) to use at that service, comma-separated, best first. Gemini sets its free limits per model (check your own in AI Studio), so the second one should still answer when the first has used up its own. Model names get retired (Google retired `gemini-2.5-flash` for new projects in 2026): if a service answers 404, list what your key can use (below) and set this |
| `GEMINI_REASONING` / `GROQ_REASONING` / `OPENROUTER_REASONING` | `minimal` / `low` / `off` | How hard a thinking model may think (smaller is faster and uses less allowance); `off` for models that do not take the setting. A model that rejects the setting is retried without it automatically |
| `AGENT_BASE_URL`, `AGENT_API_KEY`, `AGENT_MODEL`, `AGENT_REASONING` | none | Any other service that speaks the chat-completions API (Mistral, Cerebras, a model on your own server with Ollama). Tried first when set. |
| `AGENT_MESSAGES_PER_5_MIN`, `AGENT_MESSAGES_PER_DAY`, `AGENT_TOKENS_PER_USER_DAY`, `AGENT_CALLS_PER_DAY` | 15, 60, 150000, 800 | The limits in the table above. Keep `AGENT_CALLS_PER_DAY` under your free daily request allowance. |

### What "free" means here, honestly

These numbers were reported by the services or by third parties when this was written and **change often; confirm them in each console before relying on them**:

- **Gemini free tier**: no card, but requests per minute and per day are small (reported around 10 per minute and a few hundred to ~1,500 per day for Flash models; Google publishes the exact figures only inside AI Studio, at <https://aistudio.google.com/rate-limit>). Gemini 3.x models always think a little (it cannot be switched off), so the smallest setting (`minimal`) is used to keep answers quick. In the first real test a call took 20 to 35 seconds: that is too slow for a chat, so a call is given up after 25 seconds and the next model is tried (or simple mode answers). If it stays slow, tell me and we can change models or settings. **Google's terms for the free tier say content may be used to improve Google's products**, so anything a customer types to Woshi may be read by Google staff and used for training. That is why the model is sent as little personal detail as possible (above). If you would rather not accept that, turn on billing for the Google project: the paid tier is not used for training (per Google's terms; confirm), and a booking chat costs a small fraction of a rupee with a Flash model. You may also want a line about this in your privacy policy.
- **Groq free tier**: very fast, but small token limits (reported 8,000 tokens per minute and 200,000 per day for the larger models). One Woshi call carries about 2,300 tokens of fixed instructions and tools, so Groq allows only a couple of calls a minute: treat it as a fallback, not the main service.
- **OpenRouter free models**: reported 20 requests per minute and 50 a day without credit (more after a small top-up). `openrouter/free` picks whichever free model is available, so quality and tool-calling reliability vary; it is the last resort.
- **Cerebras** offers only a 30-day trial credit, not a free tier for life; it can be added through `AGENT_BASE_URL` if you want it.
- **Your own model** (Ollama) is free and private but needs a computer with a good GPU; Render's free web service cannot run one.

A booking chat is roughly 8 customer messages and 10 to 14 model calls. So the free allowance supports on the order of tens of booked chats a day, not thousands. If you grow past that, enable billing on the Google project: no code change.

**Free models are less reliable than paid ones** at calling tools exactly and at Hindi/Marathi. The guards make a mistake safe, not impossible: expect now and then a clumsy answer or a "let me not guess" message. Judge the quality with the red team below before you advertise it.

## Before you switch it on (these need the real model, so they were not done)

```bash
GEMINI_API_KEY=... npm run agent:ping      # tries every service you have a key for, one by one: a greeting and a price question that needs the price tool
GEMINI_API_KEY=... npm run dev:stack       # in one terminal (a local copy of WASHO with the real model)
npm run agent:speed                        # why is it slow? times each service three ways (tiny question, without thinking, full request)
npm run agent:redteam                      # in another: about 50 hostile and awkward messages, paced for free allowances (about five minutes)
AGENT_DEV_SCRIPTED=0 npm run dev:stack     # with no key set: try simple mode by hand in the browser
```

`agent:ping` prints, per service, whether it answered, how many tokens it used, and whether it called the price tool and used the answer. A service that fails is simply skipped by the assistant at run time, but fix its key or model name before relying on it. A hard failure in the red team exits with an error. Read the lines marked `review` yourself. Then try a real booking, in Hindi and Marathi too, on the local copy.

## Trying it without a key

`npm run dev:stack` starts a local copy of WASHO in which a scripted stand-in plays the model when no key is set (it follows the booking flows with tappable choices; it is not clever). With `AGENT_DEV_SCRIPTED=0` and no key, the real simple mode answers instead. Customer sign-in code is always `123456`. Razorpay is simulated.

## Tests

```bash
npx vitest run backend/tests/agent-guards.test.ts backend/tests/agent-openai.test.ts --config vitest.api.config.ts   # the guards and the connection: no database, instant
./supabase/tests/run.sh api api-agent                                                                              # the whole server with a real database: scripted model, and simple mode (api-agent-rules)
npm run test:api                                                                                                   # everything
```

## Not covered yet

- Real-model behaviour beyond the first ping: speed, tool-calling reliability over a whole booking, Hindi/Marathi, and the real free-tier limits.
- Simple mode understands English only and takes no coupons.
- The limits and chats are kept in the server's memory: they reset when the server restarts, and they are per server (fine for one Render instance; use a shared store before running several).
- Cancelling, rescheduling, refunds and complaints stay on the Washes and Help screens; the assistant points there.
- iPhone: there is no iOS app yet.
