import { PIPELINE_NODES, createRun, stepRun, resumeRun } from '/lab.mjs';

const $ = sel => document.querySelector(sel);
const rail = $('#rail');
const svg = $('#rail-svg');
const eventLine = $('#event-line');
const statusBadge = $('#run-status');
const ledgerBody = $('#ledger-body');
const ledgerTotals = $('#ledger-totals');
const btnStep = $('#btn-step');
const btnRun = $('#btn-run');
const btnReset = $('#btn-reset');
const btnApprove = $('#btn-approve');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const RUN_INTERVAL_MS = reducedMotion ? 0 : 380;

let run = null;
let timer = null;
let renderedSpans = 0;

// ---- rail construction -----------------------------------------------------

for (const node of PIPELINE_NODES) {
  const li = document.createElement('li');
  li.className = 'station';
  li.id = `st-${node}`;
  li.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="station-name">${node}</span>`;
  rail.appendChild(li);
}

// The vermilion arc: review curves back over the rail to create. Geometry is
// computed from the rendered station positions so it tracks any wrap/zoom.
const NS = 'http://www.w3.org/2000/svg';
const arc = document.createElementNS(NS, 'path');
arc.setAttribute('class', 'back-arc');
arc.setAttribute('fill', 'none');
const stub = document.createElementNS(NS, 'path');
stub.setAttribute('class', 'back-stub');
stub.setAttribute('fill', 'none');
const stubX = document.createElementNS(NS, 'path');
stubX.setAttribute('class', 'stub-x');
const packet = document.createElementNS(NS, 'circle');
packet.setAttribute('class', 'packet');
packet.setAttribute('r', '5');
packet.setAttribute('visibility', 'hidden');
svg.append(arc, stub, stubX, packet);

function layoutArc() {
  const wrap = svg.parentElement.getBoundingClientRect();
  const center = id => {
    const r = $(`#st-${id}`).getBoundingClientRect();
    return { x: r.left + r.width / 2 - wrap.left, y: r.top - wrap.top };
  };
  const review = center('review');
  const create = center('create');
  svg.setAttribute('viewBox', `0 0 ${wrap.width} ${wrap.height}`);
  const apex = Math.min(review.y, create.y) - 34;
  arc.setAttribute('d', `M ${review.x} ${review.y - 14} C ${review.x} ${apex - 40}, ${create.x} ${apex - 40}, ${create.x} ${create.y - 14}`);
  // Severed stub for chain mode: a short dashed climb out of review, cut
  // mid-air with an X — the edge that isn't there.
  stub.setAttribute('d', `M ${review.x} ${review.y - 14} C ${review.x} ${apex - 18}, ${review.x - 46} ${apex - 22}, ${review.x - 66} ${apex - 26}`);
  const ex = review.x - 66, ey = apex - 26;
  stubX.setAttribute('d', `M ${ex - 5} ${ey - 5} L ${ex + 5} ${ey + 5} M ${ex + 5} ${ey - 5} L ${ex - 5} ${ey + 5}`);
}

function station(node) { return $(`#st-${node}`); }

function paintStations() {
  const seen = new Set(run.spans.map(s => s.node));
  // approve has no work span — its "done" signal is the resume event
  if (run.log.some(e => e.type === 'exit' && e.node === 'approve')) seen.add('approve');
  for (const node of PIPELINE_NODES) {
    const el = station(node);
    el.classList.toggle('done', seen.has(node));
    el.classList.toggle('active', run.node === node || (node === 'approve' && run.status === 'awaiting-approval'));
    el.classList.remove('dead');
  }
  if (run.status === 'dead-ended') station('review').classList.add('dead');
  // Nodes still queued but provably unreachable after a dead-end.
  const unreachable = run.status === 'dead-ended';
  for (const node of ['approve', 'publish']) {
    if (unreachable && !seen.has(node)) station(node).classList.add('unreachable');
    else station(node).classList.remove('unreachable');
  }
}

// ---- tape -------------------------------------------------------------------

function cellValue(id, value, wiped) {
  const cell = $(`#cell-${id}`);
  cell.querySelector('.cell-v').textContent = wiped ? 'wiped' : value;
  cell.classList.toggle('wiped', Boolean(wiped));
}

function paintTape(state, spans, justLost) {
  const ms = spans.reduce((s, r) => s + r.ms, 0);
  cellValue('attempts', String(state.attempts), justLost);
  cellValue('research', state.research ? `${state.research.sources} sources` : '—', justLost);
  cellValue('plan', state.plan ? `${state.plan.length} beats` : '—', justLost);
  cellValue('draft', state.draft ? `a${state.attempts}` : '—', justLost);
  cellValue('score', state.score === null ? '—' : state.score.toFixed(2), justLost);
  cellValue('ms', String(ms), false);
  if (justLost) {
    for (const id of ['attempts', 'research', 'plan', 'draft', 'score']) {
      const cell = $(`#cell-${id}`);
      cell.classList.remove('flash');
      void cell.offsetWidth; // restart the wipe animation
      cell.classList.add('flash');
    }
  }
}

// ---- ledger -----------------------------------------------------------------

function paintLedger(spans) {
  for (; renderedSpans < spans.length; renderedSpans += 1) {
    const s = spans[renderedSpans];
    const tr = document.createElement('tr');
    if (s.retry) tr.className = 'retry';
    if (s.status === 'fail') tr.classList.add('fail');
    tr.innerHTML = `<td>${s.node}</td><td>${s.attempt}</td><td>${s.cycle}</td><td>${s.ms}</td><td>${s.status}${s.retry ? ' · retry' : ''}</td>`;
    ledgerBody.appendChild(tr);
  }
  const total = spans.reduce((s, r) => s + r.ms, 0);
  const retry = spans.filter(s => s.retry).reduce((s, r) => s + r.ms, 0);
  ledgerTotals.innerHTML = spans.length
    ? `total <strong>${total} ms</strong>${retry ? ` · retry cost <strong class="retry-ms">${retry} ms</strong>` : ''}`
    : '—';
}

// ---- run control --------------------------------------------------------------

function paintStatus() {
  statusBadge.textContent = run.status;
  statusBadge.className = `badge st-${run.status}`;
}

function paintEvent(e) {
  if (!e) return;
  eventLine.innerHTML = '';
  const cyc = run.mode === 'while' ? `cycle ${e.cycle} · ` : '';
  eventLine.append(`step ${run.log.length} · ${cyc}${e.type} — ${e.detail}`);
  paintStations();
  paintTape(e.state, e.spans, e.type === 'state-lost');
  paintLedger(e.spans);
  paintStatus();

  if (e.type === 'back-edge') {
    arc.classList.add('lit');
    pulsePacket();
  }
  if (e.type === 'state-lost') {
    // The while-loop re-travels the same route — but nothing rides it.
    pulsePacket();
    arc.classList.add('flash');
    setTimeout(() => arc.classList.remove('flash'), 700);
  }
  if (e.type === 'dead-end') station('review').classList.add('dead');

  const waiting = run.status === 'awaiting-approval';
  btnApprove.hidden = !waiting;
  btnStep.disabled = waiting || run.status !== 'running';
  btnRun.disabled = waiting || run.status !== 'running';
  if (run.status !== 'running' && !waiting) stopTimer();
}

function pulsePacket() {
  if (reducedMotion) return;
  const len = arc.getTotalLength();
  const t0 = performance.now();
  const dur = 620;
  packet.setAttribute('visibility', 'visible');
  const tick = now => {
    const t = Math.min((now - t0) / dur, 1);
    // The arc path is drawn review → create, so t sweeps the packet backward.
    const p = arc.getPointAtLength(len * t);
    packet.setAttribute('cx', p.x);
    packet.setAttribute('cy', p.y);
    if (t < 1) requestAnimationFrame(tick);
    else packet.setAttribute('visibility', 'hidden');
  };
  requestAnimationFrame(tick);
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

function newRun() {
  stopTimer();
  run = createRun({ mode: document.querySelector('input[name="mode"]:checked').value });
  renderedSpans = 0;
  ledgerBody.innerHTML = '';
  ledgerTotals.textContent = '—';
  arc.classList.remove('lit');
  arc.classList.toggle('severed', run.mode === 'chain');
  stub.classList.toggle('show', run.mode === 'chain');
  stubX.classList.toggle('show', run.mode === 'chain');
  packet.setAttribute('visibility', 'hidden');
  btnApprove.hidden = true;
  paintStations();
  paintTape(run.state, [], false);
  paintStatus();
  eventLine.textContent = run.mode === 'chain'
    ? 'chain mode — every edge points right; a failed review has nowhere to go.'
    : run.mode === 'while'
      ? 'while mode — the loop retries, but every restart runs the chain cold.'
      : 'graph mode — the review → create edge is live; watch the tape survive the retry.';
  btnStep.disabled = false;
  btnRun.disabled = false;
}

function doStep() {
  const e = stepRun(run);
  if (e) paintEvent(e);
}

function runToEndUi() {
  stopTimer();
  if (RUN_INTERVAL_MS === 0) {
    let e;
    while ((e = stepRun(run))) paintEvent(e);
    return;
  }
  btnStep.disabled = true;
  btnRun.disabled = true;
  timer = setInterval(() => {
    const e = stepRun(run);
    if (!e) { stopTimer(); return; }
    paintEvent(e);
    if (run.status !== 'running') stopTimer();
  }, RUN_INTERVAL_MS);
}

btnStep.addEventListener('click', doStep);
btnRun.addEventListener('click', runToEndUi);
btnReset.addEventListener('click', newRun);
btnApprove.addEventListener('click', () => {
  resumeRun(run);
  btnApprove.hidden = true;
  runToEndUi();
});
for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', newRun);
}
addEventListener('resize', layoutArc);

newRun();
layoutArc();
