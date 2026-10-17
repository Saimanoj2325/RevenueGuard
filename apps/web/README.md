# RevenueGuard AI — web dashboard ("Forensic Ledger")

Next.js 14 (App Router) · TypeScript · Tailwind · framer-motion · @xyflow/react · zustand · recharts · lucide.
Talks to the API exactly as specified in `docs/CONTRACT.md` (REST + `ws://…/ws?token=`).

```bash
npm install
npm run dev            # real API at NEXT_PUBLIC_API_URL (default http://localhost:8000)
npm run dev:mock       # in-browser mock backend, no API needed
npm run build          # standalone server build (used by Dockerfile)
npm run build:static   # mock-mode static export → ./out (host anywhere; e.g. `npx serve out`)
```

## Screens
`/login` (demo quick-pick) · `/cases` · `/case?id=RG-1042` (header, timeline spine, evidence board, orchestration,
facts, proposal/claims, approval, execution + verifier, audit) · `/approvals` · `/triage` · `/escalations` ·
`/connectors` · `/demo` (scene stepper 0–11, chaos, kill switch, guardrail feed, live mini case) · `/audit` · `/metrics`.

The case file uses a query param (`/case?id=`) so the static export works for any case id.

## Data layer
- `src/lib/api.ts` — typed client for every contract endpoint; same calls route to the mock when `NEXT_PUBLIC_MOCK=true`.
- `src/lib/store.ts` — auth (persisted), WebSocket store with exponential-backoff reconnect, guardrail toasts.
  `normalizeWs()` accepts `agent.event` as `{type, event:{…}}`, `{type, data:{…}}` or flattened with `event_type`
  (the contract's `{type:"agent.event", ...agent event}` collides on `type`).
- `src/lib/mock/` — full PO-184 story, chaos events, role-checked approvals, stale-approval expiry, gateway
  idempotency, verifier. State persists in `localStorage` (`rg-mock-db-v2`); a reload mid-scene drops that scene's
  remaining steps (replay it from the control room).

## UI-tolerated extensions (optional fields, rendered when present)
`case.severity_probs`, `detail.facts` (else read from the latest checkpoint `payload.facts`), `evidence.node.ruled_out`,
`approval.amount/customer/action_type/created_at`, `proposal.version/validation`, guardrail kinds beyond the contract
(`resumed`, `kill_switch`, `validator_block`). Metrics/eval pages normalise several key spellings
(`precision|exception_precision`, approaches as array or object).

## Screenshots
`scripts/screenshots.mjs` plays the whole story with Playwright against a served `out/`
(`BASE=http://localhost:4173 node scripts/screenshots.mjs`, needs `playwright` + chromium installed).

## UX v2 (khata-book redesign)

- Demo is a **runtime switch** (top bar + sign-in page), stored in `localStorage['rg.demo']`, default `NEXT_PUBLIC_MOCK`. On = in-browser mock backend; Off = real API at `NEXT_PUBLIC_API_URL`. Switching signs out and reloads.
- Routes: `/` Today · `/case?id=` · `/bill` · `/collect` · `/approvals` · `/customers` (`?id=`) · `/unlinked` · `/ask` · `/reports` · `/setup` · `/setup/connections` · `/setup/first-day` · `/settings` · `/advanced/{agents,audit,eval,cases,case,triage,escalations,metrics,connectors,demo}`. Old v1 paths redirect.
- Components: `src/components/ui/` (Money, MoneyFigure, StatusTag, ProofChip, Card, DataTable, Button, StatStrip, Journey, MoneyFlow, LiveFeed, EmptyState, ErrorState, Skeleton).
- Journey state mapping: `src/lib/journey.ts`; live-feed captions: `src/lib/captions.ts` (deterministic). i18n: `src/i18n` (en/hi/te).
- Demo business layer for every CONTRACT_V2 endpoint: `src/lib/mock/business.ts`. Today → "Replay PO-184 live" replays the story through the mock engine.
- Tests: `npm test` (vitest).
