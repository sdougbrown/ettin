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
import { existsSync, readFileSync } from "node:fs";
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

function toModel(providerId: string, baseUrl: string) {
  return (m: Record<string, unknown>): Model<"openai-completions"> => ({
    id: String(m.id),
    name: String(m.name ?? m.id),
    api: "openai-completions" as const,
    provider: providerId,
    baseUrl,
    input: (m.input as ("text" | "image")[] | undefined) ?? ["text"],
    cost: zeroCost(),
    reasoning: Boolean(m.reasoning),
    thinkingLevelMap: m.thinkingLevelMap as Model<"openai-completions">["thinkingLevelMap"],
    contextWindow: Number(m.contextWindow ?? 128_000),
    maxTokens: Number(m.maxTokens ?? 16_384),
    compat: m.compat as Model<"openai-completions">["compat"],
  });
}

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export type ModelSource =
  | { kind: "config"; models: Models; choices: HeadModelChoice[] }
  | { kind: "faux"; models: Models; choices: HeadModelChoice[]; faux: FauxProviderHandle };
/** sparky models from models.json, or the faux provider when unavailable
 * (or forced with `prefer: "faux"` for offline tests). */
export function loadModels(
  opts: {
    configPath?: string;
    allowFauxFallback?: boolean;
    prefer?: "config" | "faux";
  } = {},
): ModelSource {
  const configPath = opts.configPath ?? join(homedir(), ".pi", "agent", "models.json");
  if (opts.prefer === "faux" && opts.allowFauxFallback) return fauxSource();
  // A missing config may mean offline dev: fall back to the scripted faux
  // provider. A broken config is a startup error — silently running a room
  // of faux heads is worse than failing loudly.
  if (!existsSync(configPath)) {
    if (opts.allowFauxFallback) return fauxSource();
    throw new Error(`models config not found: ${configPath}`);
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ModelsJsonFile;
    const models = createModels();
    const choices: HeadModelChoice[] = [];
    for (const [id, cfg] of Object.entries(parsed.providers ?? {})) {
      if (!cfg?.baseUrl) continue;
      if (cfg.api !== undefined && cfg.api !== "openai-completions") {
        console.warn(
          `ettin: provider ${id} uses api=${cfg.api}; skipping (openai-completions only)`,
        );
        continue;
      }
      const chatModels = (cfg.models ?? []).filter(
        (m) => m.type === undefined || m.type === "chat",
      );
      if (chatModels.length === 0) continue;
      models.setProvider(
        createProvider<"openai-completions">({
          id,
          name: id,
          baseUrl: cfg.baseUrl,
          auth: {
            apiKey: {
              name: `${id} API key`,
              resolve: async () => ({
                auth: { apiKey: cfg.apiKey ?? "dummy" },
                source: "models.json",
              }),
            },
          },
          models: chatModels.map(toModel(id, cfg.baseUrl)),
          api: openAICompletionsApi(),
        }),
      );
      choices.push(
        ...chatModels.map((m) => ({
          provider: id,
          modelId: String(m.id),
          label: `${id}/${String(m.id)}`,
        })),
      );
    }
    if (choices.length === 0) throw new Error(`no openai-completions models in ${configPath}`);
    return { kind: "config", models, choices };
  } catch (err) {
    throw new Error(
      `failed to load models from ${configPath}: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
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
