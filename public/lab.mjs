// Loop Line lab — the domain model behind the article.
// One mechanism, three executors:
//   chain  — a DAG: brief → … → review → approve → publish. No edge goes back.
//            When review fails, the run dead-ends holding the bad draft.
//   while  — the same chain wrapped in `while (!onBrand) rerun()`. It retries,
//            but every restart re-runs the whole chain COLD: research, plan,
//            and the attempt counter are rebuilt from scratch — the state the
//            retry needed is exactly what gets wiped. Emits `state-lost`.
//   graph  — the same nodes plus one back-edge review → create. The retry
//            rides the edge carrying checkpointed state intact; on pass,
//            `interrupt()` freezes at approve until resumeRun() publishes.
//
// Everything is pure and deterministic — no timers, no I/O, no randomness.
// The browser UI (app.js), the CLI (scripts/trace.mjs), and the test suite
// all drive this module unchanged.

export const PIPELINE_NODES = ['brief', 'research', 'plan', 'create', 'review', 'approve', 'publish'];

// Forward pairs only — a chain is a DAG: every edge points right.
export const CHAIN_EDGES = [
  ['brief', 'research'],
  ['research', 'plan'],
  ['plan', 'create'],
  ['create', 'review'],
  ['review', 'approve'],
  ['approve', 'publish'],
];

// The one edge a chain cannot express: go back and try again.
export const BACK_EDGE = ['review', 'create'];
export const GRAPH_EDGES = [...CHAIN_EDGES, BACK_EDGE];

export const BRAND_PASS_SCORE = 0.8;

// Deterministic node durations in ms (attempt 1). Graph total: 10_100 ms —
// mirrors the post's "10.1 seconds, and the retry cost you 3.1s".
export const NODE_MS = { brief: 200, research: 1800, plan: 1400, create: 2400, review: 400, publish: 800 };

// Attempt >= 2 durations: the retry is slower because it drafts around the
// review feedback instead of starting blank. 2600 + 500 = 3100 ms retry cost.
export const RETRY_MS = { create: 2600, review: 500 };

// While-loop budget: how many cold restarts the patch buys before giving up.
// Each restart replays all five working nodes (6200 ms) and still scores
// 0.42, because nothing survives to tell the next attempt what went wrong.
export const WHILE_MAX_RESTARTS = 2;

export const RUN_MODES = ['chain', 'while', 'graph'];

export const SEEDED_BRIEF = {
  product: 'Meridian — a reporting copilot for growth teams',
  audience: 'growth leads at seed-stage startups',
  brandRules: [
    'plain language — no hype adjectives',
    'every asset ends with one concrete CTA',
    'numbers over adjectives',
  ],
};

// What research and plan produce — the artifacts a retry must keep.
const RESEARCH_RESULT = { sources: 14, readingHours: 6, topPain: 'reporting eats Friday afternoons' };
const PLAN_RESULT = ['hook: the Friday reporting tax', 'proof: 3 h → 20 min', 'cta: start a free audit'];

// The seeded drafts. Attempt 1 ignores the brand rules (hype, no CTA, no
// numbers) and scores 0.42. Attempt >= 2 — which only a stateful retry can
// reach — writes against the review feedback and scores 0.91.
export function draftForAttempt(n) {
  if (n === 1) {
    return {
      score: 0.42,
      onBrand: false,
      copy: 'Our revolutionary platform transforms how teams work.',
      violations: ['hype adjective "revolutionary"', 'no concrete CTA', 'zero numbers'],
    };
  }
  return {
    score: 0.91,
    onBrand: true,
    copy: 'Cut Friday reporting from 3 hours to 20 minutes. Start a free audit.',
    violations: [],
  };
}

const snap = value => structuredClone(value);

function emit(run, event) {
  const full = {
    ms: 0,
    detail: '',
    ...event,
    attempts: run.state.attempts,
    cycle: run.cycle,
    status: run.status,
    state: snap(run.state),
    spans: snap(run.spans),
  };
  run.log.push(full);
  return full;
}

export function createRun({ mode = 'graph', brief = SEEDED_BRIEF } = {}) {
  if (!RUN_MODES.includes(mode)) {
    throw new RangeError(`createRun: mode must be one of ${RUN_MODES.join(', ')} — got ${JSON.stringify(mode)}`);
  }
  return {
    mode,
    brief,
    status: 'running', // 'running' | 'dead-ended' | 'awaiting-approval' | 'completed'
    cycle: 1,          // while-mode restart counter (chain/graph stay at 1)
    node: null,        // node currently inside (entered, not yet exited)
    queue: [...PIPELINE_NODES],
    state: { attempts: 0, research: null, plan: null, draft: null, score: null },
    spans: [],         // LangSmith-style ledger: one row per node execution
    log: [],           // every emitted step event, in order
  };
}

function nodeMs(node, attempts) {
  if (attempts >= 2 && RETRY_MS[node] !== undefined) return RETRY_MS[node];
  return NODE_MS[node] ?? 0;
}

function enterNode(run) {
  const node = run.queue[0];
  if (node === 'approve') {
    // interrupt(): freeze with state checkpointed. resumeRun() is the only
    // way forward — the agent resumes exactly where it left off.
    run.status = 'awaiting-approval';
    return emit(run, {
      type: 'interrupt', node,
      detail: 'interrupt() — run paused for human approval; state checkpointed',
    });
  }
  run.node = node;
  return emit(run, { type: 'enter', node, detail: `enter ${node}` });
}

function exitNode(run) {
  const node = run.node;
  run.queue.shift();
  run.node = null;

  switch (node) {
    case 'brief':
      run.state.brief = run.brief.product;
      break;
    case 'research':
      run.state.research = snap(RESEARCH_RESULT);
      break;
    case 'plan':
      run.state.plan = [...PLAN_RESULT];
      break;
    case 'create': {
      run.state.attempts += 1;
      run.state.draft = draftForAttempt(run.state.attempts);
      run.state.score = null;
      break;
    }
    case 'review': {
      const { score } = run.state.draft;
      run.state.score = score;
      const pass = score >= BRAND_PASS_SCORE;
      const ms = nodeMs(node, run.state.attempts);
      run.spans.push({
        node, attempt: run.state.attempts, cycle: run.cycle, ms,
        status: pass ? 'pass' : 'fail',
        retry: run.state.attempts >= 2, // this review row IS the retry cost
      });
      if (pass) {
        return emit(run, { type: 'exit', node, ms, detail: `review ${score.toFixed(2)} ≥ ${BRAND_PASS_SCORE.toFixed(2)} — on brand` });
      }
      return failReview(run, ms);
    }
    case 'publish':
      break;
    default:
      break;
  }

  const ms = nodeMs(node, run.state.attempts);
  run.spans.push({
    node, attempt: run.state.attempts, cycle: run.cycle, ms, status: 'ok',
    // Only a create re-entry via the back-edge counts as retry work —
    // publish runs in attempt 2's pass but is forward progress, not retry.
    retry: node === 'create' && run.state.attempts >= 2,
  });
  if (node === 'publish') {
    run.status = 'completed';
    return emit(run, { type: 'complete', node, ms, detail: 'published — run complete' });
  }
  return emit(run, { type: 'exit', node, ms, detail: `${node} done` });
}

// review failed (score < BRAND_PASS_SCORE). What happens next is the whole
// article: it depends on the topology, not the code inside the nodes.
function failReview(run, ms) {
  const score = run.state.draft.score;
  const detail = `review ${score.toFixed(2)} < ${BRAND_PASS_SCORE.toFixed(2)} — off brand`;

  if (run.mode === 'chain') {
    // A DAG has no edge that points left. The run dead-ends at review,
    // stranded holding the bad draft.
    run.status = 'dead-ended';
    return emit(run, { type: 'dead-end', node: 'review', ms, detail: `${detail}; no edge back to create — dead end` });
  }

  if (run.mode === 'while') {
    // The while-loop patch: wrap the chain and re-invoke. The retry runs —
    // but the chain restarts cold, so research, plan, the draft, and the
    // attempt counter are all wiped. Nothing tells attempt "1" (again) what
    // went wrong, so the same off-brand draft comes back.
    if (run.cycle > WHILE_MAX_RESTARTS) {
      run.status = 'dead-ended';
      return emit(run, {
        type: 'dead-end', node: 'review', ms,
        detail: `${detail}; loop budget exhausted — ${run.cycle} cold runs, still off brand`,
      });
    }
    run.cycle += 1;
    run.state = { attempts: 0, research: null, plan: null, draft: null, score: null };
    run.queue = [...PIPELINE_NODES];
    return emit(run, {
      type: 'state-lost', node: 'review', ms,
      detail: `${detail}; while-loop restarts the chain cold — research, plan, attempts wiped`,
    });
  }

  // graph: the back-edge fires. research, plan, and the attempt counter ride
  // review → create intact; attempt 2 drafts against the feedback.
  run.queue = ['create', 'review', ...run.queue];
  return emit(run, {
    type: 'back-edge', node: 'review', to: 'create', ms,
    detail: `${detail}; edge review → create fires — state rides it back`,
  });
}

// One micro-step: enter the queued node, exit the entered node, or fire the
// routing event a failed review produces. Returns null once the run leaves
// 'running' (use resumeRun to continue from 'awaiting-approval').
export function stepRun(run) {
  if (run.status !== 'running') return null;
  return run.node === null ? enterNode(run) : exitNode(run);
}

// Valid only from 'awaiting-approval' — the human gate. Consumes the approve
// node; the next stepRun continues to publish from the intact checkpoint.
export function resumeRun(run) {
  if (run.status !== 'awaiting-approval') {
    throw new Error(`resumeRun: run is ${JSON.stringify(run.status)}, not awaiting-approval`);
  }
  run.queue.shift(); // consume 'approve'
  run.status = 'running';
  return emit(run, { type: 'exit', node: 'approve', ms: 0, detail: 'approved — resuming from checkpoint' });
}

// Drain stepRun until the run leaves 'running'. Does NOT auto-approve:
// a graph run stops at 'awaiting-approval' — call resumeRun, then runToEnd
// again to finish. retryMs = the spans the back-edge re-ran (create+review
// at attempt >= 2).
export function runToEnd(run) {
  const events = [];
  let event;
  while ((event = stepRun(run)) !== null) events.push(event);
  const spans = spanLedger(run);
  return {
    status: run.status,
    state: snap(run.state),
    spans,
    events,
    cycles: run.cycle,
    totalMs: spans.reduce((sum, s) => sum + s.ms, 0),
    retryMs: spans.filter(s => s.retry).reduce((sum, s) => sum + s.ms, 0),
  };
}

// The accumulated span ledger — [{node, attempt, cycle, ms, status}].
// Retries and cold restarts append rows; nothing is ever overwritten,
// which is exactly what makes the retry cost (and the while-loop burn)
// visible.
export function spanLedger(run) {
  return snap(run.spans);
}
