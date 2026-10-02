import { run } from "./dota-results-import.mjs";
import { isPollWindow } from "../src/lib/dota-import.js";

// One backend writer process. Schedule the next check only after the
// current one finishes, so a slow API/S3 call cannot create overlapping runs.
export function startResultsWorker({ runOnce = run, now = () => new Date(),
  env = process.env, intervalMs = 5 * 60_000, setTimer = setTimeout,
  clearTimer = clearTimeout, logger = console } = {}) {
  let timer;
  let stopped = env.YCS_DOTA_RESULTS_IMPORT_ENABLED === "false";
  let active;
  const controller = new AbortController();
  const state = { status: stopped ? "disabled" : "waiting", lastAttemptAt: null, lastSuccessAt: null };

  async function check() {
    if (stopped) return;
    const at = now();
    if (isPollWindow(at)) {
      state.status = "running";
      state.lastAttemptAt = at.toISOString();
      try {
        await runOnce({ now: at, env, signal: controller.signal });
        state.status = "waiting";
        state.lastSuccessAt = now().toISOString();
      } catch (error) {
        state.status = "error";
        if (!stopped) logger.error(`Dota results import failed: ${error.message}`);
      }
    }
    if (!stopped) timer = setTimer(() => { active = check(); }, intervalMs);
  }

  if (!stopped) active = check();
  return {
    state,
    async stop() {
      stopped = true;
      clearTimer(timer);
      controller.abort();
      await active;
    },
  };
}
