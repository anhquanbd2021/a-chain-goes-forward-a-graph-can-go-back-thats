import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_NODES, CHAIN_EDGES, BACK_EDGE, GRAPH_EDGES,
  BRAND_PASS_SCORE, NODE_MS, RETRY_MS, WHILE_MAX_RESTARTS,
  SEEDED_BRIEF, draftForAttempt,
  createRun, stepRun, resumeRun, runToEnd, spanLedger,
} from '../public/lab.mjs';
import { SCENARIOS, simulate, compareModes } from '../public/scenarios.mjs';

// ---- topology ---------------------------------------------------------------

test('a chain is a DAG: every edge points forward; the back-edge is graph-only', () => {
  const order = new Map(PIPELINE_NODES.map((n, i) => [n, i]));
  for (const [a, b] of CHAIN_EDGES) assert.ok(order.get(a) < order.get(b), `${a}→${b} must point forward`);
  assert.deepEqual(BACK_EDGE, ['review', 'create']);
  assert.ok(order.get(BACK_EDGE[0]) > order.get(BACK_EDGE[1]), 'the back-edge must point backward');
  assert.equal(GRAPH_EDGES.length, CHAIN_EDGES.length + 1);
  assert.deepEqual(GRAPH_EDGES.at(-1), BACK_EDGE);
});

test('seeded draft: attempt 1 flunks, attempt >= 2 passes', () => {
  assert.equal(draftForAttempt(1).score, 0.42);
  assert.equal(draftForAttempt(1).onBrand, false);
  assert.equal(draftForAttempt(2).score, 0.91);
  assert.equal(draftForAttempt(2).onBrand, true);
  assert.equal(draftForAttempt(7).score, 0.91);
});

test('createRun rejects an unknown mode', () => {
  assert.throws(() => createRun({ mode: 'spiral' }), RangeError);
});

// ---- chain: the dead end ----------------------------------------------------

test('chain mode: failed review dead-ends the run holding the bad draft', () => {
  const run = createRun({ mode: 'chain', brief: SEEDED_BRIEF });
  const events = [];
  let e;
  while ((e = stepRun(run))) events.push(e);

  assert.equal(run.status, 'dead-ended');
  const dead = events.at(-1);
  assert.equal(dead.type, 'dead-end');
  assert.equal(dead.node, 'review');
  // The run is stranded *holding* the off-brand draft — state kept the work.
  assert.equal(run.state.draft.score, 0.42);
  assert.equal(run.state.attempts, 1);
  assert.ok(run.state.research && run.state.plan, 'research and plan were produced then stranded');
  // Five spans executed; approve and publish never ran.
  assert.deepEqual(run.spans.map(s => s.node), ['brief', 'research', 'plan', 'create', 'review']);
  assert.equal(spanLedger(run).reduce((s, r) => s + r.ms, 0), 6200);
  assert.equal(stepRun(run), null, 'a dead-ended run cannot step');
});

// ---- while: retries without memory ------------------------------------------

test('while mode: emits state-lost and wipes research, plan, attempts', () => {
  const run = createRun({ mode: 'while' });
  const events = [];
  let e;
  while ((e = stepRun(run))) events.push(e);

  const lost = events.filter(ev => ev.type === 'state-lost');
  assert.equal(lost.length, WHILE_MAX_RESTARTS);
  for (const ev of lost) {
    assert.equal(ev.state.attempts, 0, 'attempt counter reset');
    assert.equal(ev.state.research, null, 'research wiped');
    assert.equal(ev.state.plan, null, 'plan wiped');
    assert.equal(ev.state.draft, null, 'draft wiped');
  }
  // The while loop burns budget and still fails: cold restarts can never
  // reach draftForAttempt(2), because the counter resets before each one.
  assert.equal(run.status, 'dead-ended');
  assert.equal(run.cycle, WHILE_MAX_RESTARTS + 1);
  assert.equal(run.state.attempts, 1, 'final cold run produced attempt 1 again');
  assert.equal(run.state.score, 0.42);
  // The ledger remembers what the state forgot: three full chain passes.
  const ledger = spanLedger(run);
  assert.equal(ledger.length, 15);
  assert.equal(ledger.filter(s => s.node === 'research').length, 3, 'research re-fetched every cycle');
  assert.equal(ledger.reduce((s, r) => s + r.ms, 0), 18_600);
});

// ---- graph: the loop --------------------------------------------------------

test('graph mode: back-edge review→create retries with state intact, then interrupt pauses', () => {
  const run = createRun({ mode: 'graph' });
  const events = [];
  let e;
  while ((e = stepRun(run))) events.push(e);

  const back = events.find(ev => ev.type === 'back-edge');
  assert.ok(back, 'back-edge fired');
  assert.equal(back.node, 'review');
  assert.equal(back.to, 'create');
  // The retry rode the edge carrying the checkpoint: research and plan intact.
  const after = events.find(ev => ev.type === 'exit' && ev.node === 'create' && ev.attempts === 2);
  assert.ok(after, 'create ran a second attempt');
  assert.equal(after.state.attempts, 2);
  assert.equal(after.state.research.sources, 14);
  assert.deepEqual(after.state.plan.length, 3);
  assert.equal(after.state.draft.score, 0.91);

  assert.equal(run.status, 'awaiting-approval');
  assert.equal(events.at(-1).type, 'interrupt');
  assert.equal(events.at(-1).node, 'approve');
  assert.equal(stepRun(run), null, 'a paused run waits for resumeRun');
});

test('graph mode: resumeRun publishes from the checkpoint; run completes', () => {
  const run = createRun({ mode: 'graph' });
  const first = runToEnd(run);
  assert.equal(first.status, 'awaiting-approval');

  assert.throws(() => resumeRun(createRun({ mode: 'graph' })), /awaiting-approval/);
  const resumed = resumeRun(run);
  assert.equal(resumed.node, 'approve');
  const rest = runToEnd(run);

  assert.equal(run.status, 'completed');
  assert.equal(rest.status, 'completed');
  assert.equal(rest.events.at(-1).type, 'complete');
  assert.equal(rest.state.draft.score, 0.91);

  // Totals mirror the post: 10.1 s of work, 3.1 s of it the retry.
  const ledger = spanLedger(run);
  assert.equal(ledger.reduce((s, r) => s + r.ms, 0), 10_100);
  assert.equal(rest.totalMs, 10_100);
  assert.equal(rest.retryMs, 3_100);
  assert.deepEqual(
    ledger.filter(s => s.retry).map(s => `${s.node}@${s.attempt}`),
    ['create@2', 'review@2'],
  );
  // publish ran inside attempt 2's pass but is progress, not retry cost.
  assert.equal(ledger.find(s => s.node === 'publish').retry, false);
});

// ---- shared fixtures ---------------------------------------------------------

test('scenario wrappers reproduce the same three resting states', () => {
  const [chain, whileRun, graph] = compareModes();
  assert.equal(chain.status, 'dead-ended');
  assert.equal(whileRun.status, 'dead-ended');
  assert.equal(graph.status, 'completed');
  assert.equal(graph.retryMs, 3_100);
  assert.equal(graph.totalMs, 10_100);
  assert.equal(whileRun.cycles, WHILE_MAX_RESTARTS + 1);
  assert.equal(SCENARIOS.length, 3);
});

test('timings are the deterministic fixture the article cites', () => {
  assert.equal(NODE_MS.brief + NODE_MS.research + NODE_MS.plan + NODE_MS.create + NODE_MS.review, 6_200);
  assert.equal(RETRY_MS.create + RETRY_MS.review, 3_100);
  assert.equal(BRAND_PASS_SCORE, 0.8);
});
