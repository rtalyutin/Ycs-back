import test from "node:test";
import assert from "node:assert/strict";
import { startResultsWorker } from "../backend/dota-results-worker.mjs";
import { startResultsBackend } from "../backend/server.mjs";
import { run } from "../backend/dota-results-import.mjs";

const kickoff = new Date("2026-10-09T20:30:00+03:00");
const quiet = { error() {}, log() {} };
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("server worker waits until kickoff, serializes slow imports and aborts on stop", async () => {
  let at = new Date("2026-09-30T12:00:00+03:00");
  let callback;
  let calls = 0;
  let finish;
  let signal;
  const worker = startResultsWorker({ now: () => at,
    setTimer(fn, delay) { assert.equal(delay, 300_000); callback = fn; return 1; },
    clearTimer() { callback = undefined; }, logger: quiet,
    runOnce(options) { calls++; signal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
  assert.equal(calls, 0);
  at = kickoff;
  const check = callback;
  callback = undefined;
  check();
  await settled();
  assert.equal(calls, 1);
  assert.equal(callback, undefined, "no second timer while import is still running");
  finish();
  await settled();
  assert.equal(worker.state.lastSuccessAt, kickoff.toISOString());
  callback();
  await settled();
  assert.equal(calls, 2);
  const stopping = worker.stop();
  assert.equal(signal.aborted, true);
  finish();
  await stopping;
  assert.equal(callback, undefined);
});

test("worker survives an API failure and does not import outside either evening window", async () => {
  let callback;
  let at = kickoff;
  let calls = 0;
  const errors = [];
  const worker = startResultsWorker({ now: () => at,
    setTimer(fn) { callback = fn; return 1; }, clearTimer() {},
    logger: { error(message) { errors.push(message); } },
    async runOnce() { calls++; if (calls === 1) throw new Error("API unavailable"); } });
  await settled();
  assert.equal(worker.state.status, "error");
  assert.match(errors[0], /API unavailable/);
  callback();
  await settled();
  assert.equal(calls, 2);
  assert.equal(worker.state.status, "waiting");
  at = new Date("2026-10-11T01:00:00+03:00");
  callback();
  await settled();
  assert.equal(calls, 2);
  await worker.stop();
  let timers = 0;
  const disabled = startResultsWorker({ env: { YCS_DOTA_RESULTS_IMPORT_ENABLED: "false" },
    now: () => kickoff, runOnce() { assert.fail("disabled import"); }, setTimer() { timers++; }, clearTimer() {} });
  assert.equal(timers, 0);
  await disabled.stop();
});

test("importer makes no external calls before kickoff and persists completed results only once", async () => {
  let object = null;
  let writes = 0;
  let destroyed = 0;
  const map = { match_id: 900000001, leagueid: 20164, start_time: kickoff.getTime() / 1000,
    radiant_name: "ARB Esports", dire_name: "Team Borisogleb", radiant_win: true,
    radiant_score: 18, dire_score: 32, duration: 2400, series_id: 0 };
  const options = { env: { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" },
    async fetchJson(url) { return url.endsWith("/matchIds") ? [map.match_id] : map; },
    createS3(config) {
      assert.equal(config.credentials.secretAccessKey, "test");
      return { async send(command) {
        assert.equal(command.input.Key, "results/dota2-autumn-2026.json");
        if (command.constructor.name === "PutObjectCommand") {
          object = JSON.parse(command.input.Body); writes++; return {};
        }
        if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { Body: { transformToString: async () => JSON.stringify(object) } };
      }, destroy() { destroyed++; } };
    } };
  await run({ now: new Date("2026-10-09T20:29:59+03:00"),
    createS3() { assert.fail("early S3 access"); }, fetchJson() { assert.fail("early API access"); } });
  await run({ ...options, now: new Date("2026-10-09T22:00:00+03:00") });
  assert.equal(writes, 1);
  assert.equal(object.matches["dota-autumn-swiss-r1-04"].winnerTeamId, "dota2-qual-2026-arb-esports");
  await run({ ...options, now: new Date("2026-10-09T22:05:00+03:00") });
  assert.equal(writes, 1);
  assert.equal(destroyed, 2);
  await assert.rejects(run({ now: kickoff, env: {} }), /credentials/);
});

test("small results backend starts without a site build and exposes health without HTTP import triggers", async () => {
  let imports = 0;
  let cleared = false;
  const backend = await startResultsBackend({ port: 0, host: "127.0.0.1", logger: quiet,
    env: { AWS_ACCESS_KEY_ID: "private-writer", AWS_SECRET_ACCESS_KEY: "private-secret" },
    workerOptions: { now: () => kickoff, setTimer() { return 1; },
      clearTimer() { cleared = true; }, async runOnce() { imports++; } } });
  const base = `http://127.0.0.1:${backend.server.address().port}`;
  try {
    await settled();
    assert.equal(imports, 1);
    assert.equal(backend.worker.state.status, "waiting");
    const health = await fetch(base + "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.deepEqual(await health.json(), { status: "ok" });
    const head = await fetch(base + "/healthz", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await fetch(base + "/healthz", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    for (const route of ["/", "/tg", "/assets/app.js", "/api/import", "/.env"]) {
      const response = await fetch(base + route, { method: "POST", body: "start import" });
      assert.equal(response.status, 404, route);
      assert.ok(!(await response.text()).includes("private"));
    }
    assert.equal(imports, 1, "HTTP requests never initiate an import");
  } finally { await backend.stop(); }
  assert.equal(cleared, true);
  assert.equal(backend.server.listening, false);
});
