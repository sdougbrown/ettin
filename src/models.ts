/**
 * Model access for ettin heads.
 *
 * sparky: the local LiteLLM proxy, configured in ~/.pi/agent/models.json —
 * the same models the avenor room-spike used. The provider is rebuilt here
 * with pi-ai's createProvider + openai-completions so ettin-web is
 * self-contained; model entries (ids, context windows, compat flags,
 * thinking-level maps) come straight from that file.
 *
 * faux: pi-ai's scripted provider for offline development and smoke tests.
 */
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Model } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HeadModelChoice {
  provider: string;
  modelId: string;
  label: string;
}

interface ModelsJsonFile {
  providers?: Record<
    string,
    {
      baseUrl?: string;
      api?: string;
      apiKey?: string;
      models?: Array<Record<string, unknown>>;
    }
  >;
}

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Build the sparky provider from the shared models.json config. */
function sparkyProvider(configPath: string) {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as ModelsJsonFile;
  const cfg = raw.providers?.sparky;
  if (!cfg?.baseUrl) throw new Error(`no sparky provider in ${configPath}`);
  const models: Model<"openai-completions">[] = (cfg.models ?? [])
    .filter((m) => m.type === undefined || m.type === "chat")
    .map((m) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      api: "openai-completions" as const,
      provider: "sparky",
      baseUrl: cfg.baseUrl!,
      input: (m.input as ("text" | "image")[] | undefined) ?? ["text"],
      cost: zeroCost(),
      reasoning: Boolean(m.reasoning),
      thinkingLevelMap: m.thinkingLevelMap as Model<"openai-completions">["thinkingLevelMap"],
      contextWindow: Number(m.contextWindow ?? 128_000),
      maxTokens: Number(m.maxTokens ?? 16_384),
      compat: m.compat as Model<"openai-completions">["compat"],
    }));
  const auth = {
    apiKey: {
      name: "Sparky API key",
      resolve: async () => ({ auth: { apiKey: cfg.apiKey ?? "dummy" }, source: "models.json" }),
    },
  };
  return createProvider<"openai-completions">({
    id: "sparky",
    name: "Sparky (LiteLLM)",
    baseUrl: cfg.baseUrl,
    auth,
    models,
    api: openAICompletionsApi(),
  });
}

export type ModelSource =
  | { kind: "sparky"; models: Models; choices: HeadModelChoice[] }
  | { kind: "faux"; models: Models; choices: HeadModelChoice[]; faux: FauxProviderHandle };
/** sparky models from models.json, or the faux provider when unavailable
 * (or forced with `prefer: "faux"` for offline tests). */
export function loadModels(
  opts: {
    configPath?: string;
    allowFauxFallback?: boolean;
    prefer?: "sparky" | "faux";
  } = {},
): ModelSource {
  if (opts.prefer === "faux" && opts.allowFauxFallback) return fauxSource();
  const configPath = opts.configPath ?? join(homedir(), ".pi", "agent", "models.json");
  try {
    const sparky = sparkyProvider(configPath);
    const models = createModels();
    models.setProvider(sparky);
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as ModelsJsonFile;
    const choices = (raw.providers?.sparky?.models ?? [])
      .filter((m) => m.type === undefined || m.type === "chat")
      .map((m) => ({
        provider: "sparky",
        modelId: String(m.id),
        label: String(m.name ?? m.id),
      }));
    return { kind: "sparky", models, choices };
  } catch (err) {
    if (!opts.allowFauxFallback) throw err;
    return fauxSource();
  }
}

function fauxSource(): ModelSource {
  {
    const faux = fauxProvider({
      provider: "faux",
      api: "faux",
      models: [
        {
          id: "faux-a",
          name: "Faux A",
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
        {
          id: "faux-b",
          name: "Faux B",
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      ],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    return {
      kind: "faux",
      models,
      choices: [
        { provider: "faux", modelId: "faux-a", label: "Faux A (scripted)" },
        { provider: "faux", modelId: "faux-b", label: "Faux B (scripted)" },
      ],
      faux,
    };
  }
}

export function thinkingLevel(_model: unknown, level: string | undefined): string {
  return level ?? "off";
}
