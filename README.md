# Loop Line — companion demo

Interactive lab for the article *A Chain Goes Forward. A Graph Can Go Back.
That's the Whole Difference.* One seeded marketing agent —
`brief → research → plan → create → review` — runs through three executors,
and only the topology changes.

Zero dependencies — Node 24+ only. The run machine is a plain ES module
shared unchanged by the browser UI, the CLI, the HTTP API, and the test
suite.

## What it proves

`review` scores the seeded first draft at 0.42 against a 0.80 brand bar.
What happens next is the whole argument:

| Mode | What happens | Resting state |
|---|---|---|
| `chain` | `review` has no edge back — the run dead-ends holding the bad draft | `dead-ended` after 6.2 s |
| `while` | the loop retries, but every restart re-runs the chain cold — `research`, `plan`, `attempts` wiped, same 0.42 draft | `dead-ended` after 18.6 s |
| `graph` | the `review → create` back-edge fires with state intact; attempt 2 scores 0.91; `interrupt()` pauses for approval | `completed` after 10.1 s, 3.1 s retry |

The lab renders it as a transit line: seven stations, a dotted vermilion
back-edge arc, a checkpoint **state tape** that visibly blanks in `while`
mode, and a LangSmith-style **trace ledger** where the retry rows are the
vermilion ones.

## Run it

```text
npm start        # serve the lab on http://localhost:3000
npm test         # unit suite + end-to-end server suite
npm run trace    # CLI: span ledgers for chain / while / graph
npm run check    # both
```

`node scripts/trace.mjs --mode while` prints one ledger — watch `research`
get re-fetched every cycle. `GET /api/run?mode=graph` returns the full run
as JSON from the same module the browser imports.

## Layout

- `public/lab.mjs` — the domain model: `createRun`, `stepRun`, `resumeRun`, `runToEnd`, `spanLedger`
- `public/scenarios.mjs` — the three-mode fixtures re-exported for UI/CLI/tests
- `public/app.js` — UI wiring: rail, back-edge arc, state tape, ledger, controls
- `app/server.js` — zero-dependency static host plus `/health`, `/version`, `/api/run`
- `scripts/trace.mjs` — the CLI ledger printer
- `test/` — `node --test "test/*.test.mjs"`

Repo: [github.com/anhquanbd2021/a-chain-goes-forward-a-graph-can-go-back-thats](https://github.com/anhquanbd2021/a-chain-goes-forward-a-graph-can-go-back-thats)

## Honest limits

- Timings are deterministic fixtures mirroring the article's numbers, not
  measured LLM latency.
- Real model output is stochastic; the seeded 0.42-then-0.91 drafts exist to
  isolate topology as the only variable.
- The simulated `interrupt()` is an in-memory pause flag — real durable
  execution persists checkpoints across process restarts.
- The ledger mimics a trace view; it is not an observability platform.

This is an educational demo, not production infrastructure.
