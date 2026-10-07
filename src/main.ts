/**
 * Ettin — entry point.
 *
 * Usage:
 *   npm start [-- --db ./data/ettin.sqlite --workspace /path/to/repo --port 7947]
 *
 * Heads default to two sparky models; when the sparky proxy is unreachable,
 * the faux provider takes over so the room runs end to end offline.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EttinApp } from "./app.ts";
import { MarkerGovernor } from "./room/governor.ts";
import { LocalDecisionsGovernor, TypeSafeGovernor } from "./room/governor_jev.ts";
import { serve } from "./server.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const { values } = parseArgs({
  options: {
    governor: { type: "string", default: "marker" },
    "jev-key-file": { type: "string", default: "" },
    "decisions-url": { type: "string", default: "http://localhost:8081/v1/decisions" },
    "decisions-model": { type: "string", default: "" },
    db: { type: "string", default: "./data/ettin.sqlite" },
    workspace: { type: "string", default: "./workspace" },
    port: { type: "string", default: "7947" },
    "max-depth": { type: "string", default: "2" },
    "max-auto": { type: "string", default: "8" },
    excerpt: { type: "string", default: "1200" },
    thinking: { type: "string", default: "off" },
    heads: { type: "string", default: "a,b" },
  },
});

async function main(): Promise<void> {
  const dbPath = resolve(values.db!.replace(/^\.\//, `${process.cwd()}/`));
  mkdirSync(resolve(values.workspace!), { recursive: true });
  mkdirSync(dbPath.slice(0, dbPath.lastIndexOf("/")) || ".", { recursive: true });

  // Turn governor: marker (deterministic floor), official Jev, or a local
  // /decisions endpoint. Decision APIs fall back to the marker on any error.
  let governor;
  if (values.governor === "jev") {
    const key = values["jev-key-file"]
      ? readFileSync(values["jev-key-file"], "utf8").trim()
      : readFileSync(`${homedir()}/.secrets/jev.key`, "utf8").trim();
    governor = new TypeSafeGovernor({
      apiKey: key,
      fallback: new MarkerGovernor(),
      threshold: 0.35,
    });
    console.log("ettin: governor=jev (TypeSafe systemone; fallback: marker)");
  } else if (values.governor === "decisions") {
    const key = values["jev-key-file"] ? readFileSync(values["jev-key-file"], "utf8").trim() : "";
    governor = new LocalDecisionsGovernor(
      { apiKey: key, fallback: new MarkerGovernor(), threshold: 0.35 },
      values["decisions-url"],
      values["decisions-model"] || undefined,
    );
    console.log(`ettin: governor=decisions (${values["decisions-url"]}; fallback: marker)`);
  } else {
    governor = new MarkerGovernor();
  }

  const app = new EttinApp({
    dbPath,
    workspace: resolve(values.workspace!),
    thinkingLevel: values.thinking!,
    maxDepth: Number(values["max-depth"]),
    maxAuto: Number(values["max-auto"]),
    excerptLimit: Number(values.excerpt),
    governor,
    roomRef: "room_log tool (the shared room record)",
  });
  await app.open();

  // Bootstrap the heads listed in --heads with default models.
  const names = values
    .heads!.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    await app.addHead(name);
  }

  serve(app, { port: Number(values.port), uiDir: join(here, "..", "ui") });
  console.log(
    `ettin: room ready on http://localhost:${values.port} (workspace: ${app.options.workspace})`,
  );
  console.log(
    `ettin: models: ${app.models.kind} — heads: ${app.heads
      .list()
      .map((h) => `${h.name}=${h.provider}/${h.model}`)
      .join(", ")}`,
  );
  void BACKGROUND_CONTEXT;
}

main().catch((err) => {
  console.error("ettin: fatal:", err);
  process.exit(1);
});
