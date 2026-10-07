import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from '../app/server.js';
import { once } from 'node:events';

async function withServer(fn) {
  const server = createStaticServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('pages, /health, /version respond; static allowlist serves the lab', async () => {
  await withServer(async base => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');

    const version = await fetch(`${base}/version`);
    assert.equal(version.status, 200);
    const meta = await version.json();
    assert.equal(meta.name, 'a-chain-goes-forward-a-graph-can-go-back-thats-demo');
    assert.ok(meta.version && meta.commit);

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /<nav aria-label="Primary">/);
    assert.match(html, /aria-current="page" href="\/"/);
    assert.match(html, /href="\/guide\.html"/);
    assert.match(html, /github\.com\/anhquanbd2021\/a-chain-goes-forward-a-graph-can-go-back-thats/);

    const guide = await fetch(`${base}/guide.html`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /aria-current="page" href="\/guide\.html"/);

    for (const path of ['/app.js', '/lab.mjs', '/scenarios.mjs', '/styles.css', '/pb-shell.css', '/pb-back.css']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
    }
  });
});

test('/api/run drives the real model: graph completes, chain dead-ends', async () => {
  await withServer(async base => {
    const graph = await (await fetch(`${base}/api/run?mode=graph`)).json();
    assert.equal(graph.status, 'completed');
    assert.equal(graph.totalMs, 10_100);
    assert.equal(graph.retryMs, 3_100);
    assert.equal(graph.attempts, 2);
    assert.equal(graph.score, 0.91);

    const chain = await (await fetch(`${base}/api/run?mode=chain`)).json();
    assert.equal(chain.status, 'dead-ended');
    assert.equal(chain.attempts, 1);

    const bad = await fetch(`${base}/api/run?mode=spiral`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /chain/);
  });
});

test('security headers ride every response; 404s and HEAD behave', async () => {
  await withServer(async base => {
    for (const path of ['/', '/health', '/nope']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, path);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
    }
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/app/server.js`)).status, 404);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });
});
