# Turncraft: Chatbot conversation designer

An AI-powered tool for designing governed chatbot conversations. Enter a user intent → map the full scenario space → generate phone-sim responses with your design system and guidelines baked in.

Standalone web app: a static frontend plus one Netlify serverless function that proxies the real Anthropic API. (Earlier versions ran as a Claude artifact inside Cowork; this version runs anywhere as a normal website — see [Architecture](#architecture) for why that changed.)

---

## Why this exists

Chatbot responses are often configured by hand with no shared standard, leading to inconsistent tone, missed edge cases, and text-heavy dead ends. Turncraft grew out of fixing that: auditing real conversations, building a shared guidelines framework, and working with engineering to transform those guidelines into prompting guidance an LLM could actually follow consistently. This tool packages the whole process so anyone can run it, test it, and evolve their own guidelines against a real scenario space instead of trusting them by inspection.

---

## What it does

- **Scenario mapping**: input a user intent and the tool expands the full scenario space (happy paths, error states, and edge cases)
- **Governed response generation**: guidelines apply in layers. Base conversation principles come first, domain-specific materials (design system, personas) add detail on top, and individual scenarios can override both when a case needs an exception
- **Phone simulator**: responses render in an interactive phone UI, each one built from the same fixed set of components (quick replies, rate cards, confirmation overlays, and more) rather than free-form text, so every response is structured the same way
- **Live editing**: edit any bubble, flip personas, apply tweaks and regenerate immediately
- **Prompt spec export**: export the full scenario set and guidelines as a shareable HTML or JSONL file, the same shape you'd use to seed a test set or evaluation run
- **Guardrails**: a dedicated, swappable guardrails material plus a free regex pre-filter, both governed by one toggle — see `static/materials/default-security-guardrails.md`

---

## Architecture

```
├── static/                        # served as-is, no build step
│   ├── index.html                 # the whole app: UI, state, prompts
│   └── materials/*.md             # bundled guidelines (fetched at runtime)
└── netlify/functions/
    └── generate.js                 # POST /api/generate → Anthropic Messages API
```

The frontend never talks to Anthropic directly. Every generation call goes through a local `askClaude(prompt)` wrapper in `static/index.html`, which `fetch()`s `/api/generate`. That function reads `ANTHROPIC_API_KEY` from the server environment (never exposed to the browser), calls the real Messages API, and returns the response in the same `{ content: [{ type: 'text', text: '...' }] }` shape the frontend already parses — so the response-handling code (`extractText()`, `parseJSON()`) didn't need to change at all.

This replaced an earlier version that called `window.cowork.askClaude(prompt)` — a binding only available when the tool was loaded live inside a Cowork/chat artifact. A platform change collapsed that binding into a more restricted artifact system, which is what prompted this rewrite; a real backend also means the tool now works as a normal public link, not just inside Claude's own apps.

### Cost protection

This is a public tool — anyone with the URL can trigger generations. Three independent layers guard against runaway cost:

1. **Per-IP rate limiting**, implemented with Netlify Blobs in `netlify/functions/generate.js` (40 requests/hour/IP by default — Turncraft's "Generate all" step fires one call per scenario concurrently, so the limit has headroom above a single normal session).
2. **A hard `max_tokens` cap**, set server-side only — the client sends a prompt string, never a token budget, so it can't be overridden from the browser.
3. **A hard spending limit set directly in the Anthropic Console** (console.anthropic.com/settings/limits) — a backstop independent of anything in this code. Set this before making the site public.

---

## Running it

### Local development

1. `npm install`
2. `cp .env.example .env` and fill in `ANTHROPIC_API_KEY` (get one at console.anthropic.com/settings/keys)
3. `npm run dev` — runs `netlify dev`, which serves `static/` and the function together (default: `http://localhost:8888`)

`netlify dev` needs the [Netlify CLI](https://docs.netlify.com/cli/get-started/) available (install globally with `npm install -g netlify-cli`, or run via `npx netlify dev`). The first time, `netlify link` (or letting `netlify dev` prompt you) connects the local folder to a Netlify site so Blobs works the same way locally as in production.

### Deploying

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In Netlify: **Add new site → Import an existing project**, point it at this repo. `netlify.toml` already declares the publish directory (`static`) and functions directory (`netlify/functions`), so the defaults should just work.
3. **Site settings → Environment variables** → add `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL` — see `.env.example`).
4. Set a hard spending limit in the Anthropic Console before the site goes live (see Cost protection above).
5. Deploy.

---

## Context & knowledge management

Turncraft doesn't hardcode a single voice or design system into the tool itself. Every response is generated against a knowledge base you control: a set of materials loaded in per session, and swappable at any time without touching the underlying tool.

Change a guideline or swap in a different design system, and every scenario in that session regenerates against the new materials immediately. The guidelines are context fed into the tool, which is what makes the same tool usable across different teams and domains. This works similarly in spirit to grounding a model in an external knowledge source, though materials here are swapped in as whole documents rather than retrieved piece by piece.

The tool ships with materials as a working default, used to govern scenario generation and response design:

| File | Description | Source |
|------|-------------|--------|
| `unified-conversation-design-principles-v2.md` | Core conversation design principles covering clarity, cooperation, turn structure, and tone | Adapted from H.P. Grice, *Logic and Conversation* (1975), and [Google Conversation Design](https://developers.google.com/assistant/conversation-design) (CC BY 4.0). Interpreted and extended for chatbot UI. |
| `design-system-material3.md` | Component usage guidance for chatbot UI based on Material Design 3 | Adapted from [Material Design 3](https://m3.material.io/) by Google (CC BY 4.0). Interpreted and extended for chatbot UI. |
| `design-system-ant-design-x.md` | Component guidance based on Ant Design X, an AI-native chat library | Adapted from [Ant Design X](https://x.ant.design/) by Ant Group (MIT). |
| `default-security-guardrails.md` | Prompt-injection and output-integrity guardrails, spliced into generation prompts when the guardrails toggle is on | Original, written for this tool. |

You can swap any of these out for your own materials from the Knowledge base panel inside the tool. Loading new materials is scoped to your current session, so switching context doesn't require redeploying or editing the tool itself.

---

## Evaluation & versioning

The bundled guidelines are tracked and tested like any other asset that governs model behavior. Changes are version-controlled with real commit history, and every version is checked against a fixed test set, a rubric written before generation, and independent cold-validation runs before being considered settled. One worked example is documented in full as a separate eval log: the [Rate Lock scenario cluster](https://cindysuryautama.github.io/turncraft-chatbot-conversation-designer/), tested across three guideline versions.

---

## License

This tool is released under the [MIT License](LICENSE).

The bundled materials are derivative works, see attribution above. Original sources are licensed under CC BY 4.0 (Google) and MIT (Ant Group). Attribution notices must be preserved when redistributing.

---

## Credits

Built by [Cindy Suryautama Sukiato](https://www.linkedin.com/in/cindy-suryautama-sukiato-17526553/).

Conversation design principles adapted from H.P. Grice (1975) and Google Conversation Design (CC BY 4.0).
Design system materials adapted from Material Design 3 by Google (CC BY 4.0) and Ant Design X by Ant Group (MIT).
