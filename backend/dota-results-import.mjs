#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import tournament from "../src/data/tournaments/dota2-autumn-2026.json" with { type: "json" };
import { collectDotaResults, isPollWindow } from "../src/lib/dota-import.js";
import { validateDotaSnapshot } from "../src/lib/dota-results.js";

const bucket = "e9dc5ea4-6dc9267d-85ca-4ae9-a41f-2895e9542a04";
const key = "results/dota2-autumn-2026.json";
const requestSignal = (signal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  : AbortSignal.timeout(20_000);
async function getJson(url, signal) {
  const response = await fetch(url, { signal: requestSignal(signal), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`OpenDota HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}

async function getLeagueMaps(leagueId, fetchJson, signal, limit = Infinity) {
  const ids = await fetchJson(`https://api.opendota.com/api/leagues/${leagueId}/matchIds`, signal);
  if (!Array.isArray(ids) || ids.some((id) => !/^[1-9]\d*$/.test(String(id)))) throw new Error("Invalid OpenDota league match IDs");
  const maps = [];
  for (const id of [...new Set(ids.map(String))].slice(0, limit)) maps.push(await fetchJson(`https://api.opendota.com/api/matches/${id}`, signal));
  return maps;
}

async function readSnapshot(s3, signal) {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: requestSignal(signal) });
    return validateDotaSnapshot(JSON.parse(await object.Body.transformToString()), tournament);
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

export async function run({ now = new Date(), env = process.env, signal,
  probeOldLeague = false, fetchJson = getJson, createS3 = (config) => new S3Client(config) } = {}) {
  if (probeOldLeague) {
    const maps = await getLeagueMaps(19021, fetchJson, signal, 1);
    console.log(`Old league 19021: ${maps.length} map fetched, ${maps[0]?.match_id ?? "none"}; no S3 write`);
    return;
  }
  if (!isPollWindow(now)) { console.log("Outside confirmed polling window; no API or S3 request"); return; }
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("S3 credentials are not configured");
  const s3 = createS3({ region: "ru-1", endpoint: "https://s3.twcstorage.ru", maxAttempts: 2,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } });
  try {
    const previous = await readSnapshot(s3, signal);
    const maps = await getLeagueMaps(tournament.leagueId, fetchJson, signal);
    const result = collectDotaResults(tournament, maps, previous, now);
    for (const warning of result.warnings) console.warn(warning);
    const unresolved = result.warnings.filter((warning) => /^(Unmatched|Unknown series|Ambiguous|Conflict)/.test(warning));
    if (!result.changed) {
      if (unresolved.length) throw new Error(`${unresolved.length} unresolved Dota result(s); see map IDs above`);
      console.log("No new confirmed series"); return;
    }
    const body = JSON.stringify(result.snapshot, null, 2) + "\n";
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body,
        ContentType: "application/json; charset=utf-8", CacheControl: "public, max-age=30" }), { abortSignal: requestSignal(signal) });
    } catch (error) {
      const afterError = await readSnapshot(s3, signal);
      if (JSON.stringify(afterError) !== JSON.stringify(result.snapshot)) throw error;
      console.log(`S3 write response unknown, readback confirmed revision ${afterError.revision}`);
      if (unresolved.length) throw new Error(`${unresolved.length} unresolved Dota result(s); see map IDs above`);
      return;
    }
    const saved = await readSnapshot(s3, signal);
    if (JSON.stringify(saved) !== JSON.stringify(result.snapshot)) throw new Error("S3 readback differs from intended snapshot");
    console.log(`Published revision ${saved.revision}: ${Object.keys(saved.matches).length} completed series`);
    if (unresolved.length) throw new Error(`${unresolved.length} unresolved Dota result(s); see map IDs above`);
  } finally { s3.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ probeOldLeague: process.argv.includes("--probe-old-league") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
