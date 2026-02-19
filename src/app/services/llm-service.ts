import {
  RemoteLLM,
  getDefaultLlamaCpp,
  withLLMSession,
  type ILLMSession,
  type Queryable,
  type RerankDocument,
  type RemoteLLMConfig,
} from "../../llm.js";
import type { LLMPort, ExpandOptions } from "../ports/llm.js";

function createRemoteConfigFromEnv(): RemoteLLMConfig | null {
  const rerankProvider = process.env.QMD_RERANK_PROVIDER as "siliconflow" | "gemini" | "openai" | "dashscope" | undefined;
  const embedProvider = process.env.QMD_EMBED_PROVIDER as "siliconflow" | "openai" | undefined;
  const queryExpansionProvider = process.env.QMD_QUERY_EXPANSION_PROVIDER as "siliconflow" | "gemini" | "openai" | undefined;
  const rerankMode = (process.env.QMD_RERANK_MODE as "llm" | "rerank" | undefined) || "llm";
  const sfApiKey = process.env.QMD_SILICONFLOW_API_KEY;
  const gmApiKey = process.env.QMD_GEMINI_API_KEY;
  const oaApiKey = process.env.QMD_OPENAI_API_KEY;
  const dsApiKey = process.env.QMD_DASHSCOPE_API_KEY;

  const sfLlmRerankModel = process.env.QMD_SILICONFLOW_LLM_RERANK_MODEL || process.env.QMD_LLM_RERANK_MODEL || "zai-org/GLM-4.5-Air";

  let effectiveRerankProvider: "siliconflow" | "gemini" | "openai" | "dashscope" | undefined;
  if (rerankMode === "rerank") {
    if (rerankProvider === "dashscope" && dsApiKey) {
      effectiveRerankProvider = "dashscope";
    } else if (sfApiKey) {
      effectiveRerankProvider = "siliconflow";
    } else if (rerankProvider === "gemini" && gmApiKey) {
      effectiveRerankProvider = "gemini";
    } else if (rerankProvider === "openai" && oaApiKey) {
      effectiveRerankProvider = "openai";
    } else if (dsApiKey) {
      effectiveRerankProvider = "dashscope";
    } else {
      effectiveRerankProvider = gmApiKey ? "gemini" : (oaApiKey ? "openai" : undefined);
    }
  } else {
    if (rerankProvider === "dashscope" && dsApiKey) {
      effectiveRerankProvider = "dashscope";
    } else if (rerankProvider === "gemini" || rerankProvider === "openai") {
      effectiveRerankProvider = rerankProvider;
    } else if (rerankProvider === "siliconflow") {
      effectiveRerankProvider = sfApiKey ? "siliconflow" : undefined;
    } else {
      effectiveRerankProvider = dsApiKey ? "dashscope" : (sfApiKey ? "siliconflow" : (gmApiKey ? "gemini" : (oaApiKey ? "openai" : undefined)));
    }
  }

  const effectiveEmbedProvider = embedProvider
    || (sfApiKey ? "siliconflow" : (oaApiKey ? "openai" : undefined));
  const effectiveQueryExpansionProvider = queryExpansionProvider
    || (sfApiKey ? "siliconflow" : (oaApiKey ? "openai" : (gmApiKey ? "gemini" : undefined)));

  if (!effectiveRerankProvider && !effectiveEmbedProvider && !effectiveQueryExpansionProvider) {
    return null;
  }

  const config: RemoteLLMConfig = {
    rerankProvider: effectiveRerankProvider || "siliconflow",
    rerankMode,
    embedProvider: effectiveEmbedProvider,
    queryExpansionProvider: effectiveQueryExpansionProvider,
  };

  if (sfApiKey) {
    config.siliconflow = {
      apiKey: sfApiKey,
      baseUrl: process.env.QMD_SILICONFLOW_BASE_URL,
      model: process.env.QMD_SILICONFLOW_RERANK_MODEL || process.env.QMD_SILICONFLOW_MODEL,
      embedModel: process.env.QMD_SILICONFLOW_EMBED_MODEL,
      queryExpansionModel: process.env.QMD_SILICONFLOW_QUERY_EXPANSION_MODEL,
    };
  }

  if (gmApiKey) {
    config.gemini = {
      apiKey: gmApiKey,
      baseUrl: process.env.QMD_GEMINI_BASE_URL,
      model: process.env.QMD_GEMINI_RERANK_MODEL || process.env.QMD_GEMINI_MODEL,
    };
  }

  if (oaApiKey || (effectiveRerankProvider === "openai" && sfApiKey)) {
    config.openai = {
      apiKey: oaApiKey || sfApiKey || "",
      baseUrl: process.env.QMD_OPENAI_BASE_URL || process.env.QMD_SILICONFLOW_BASE_URL,
      model: process.env.QMD_OPENAI_MODEL || (sfApiKey ? sfLlmRerankModel : undefined),
      embedModel: process.env.QMD_OPENAI_EMBED_MODEL,
    };
  }

  if (dsApiKey || effectiveRerankProvider === "dashscope") {
    config.dashscope = {
      apiKey: dsApiKey || "",
      baseUrl: process.env.QMD_DASHSCOPE_BASE_URL,
      model: process.env.QMD_DASHSCOPE_RERANK_MODEL,
    };
  }

  return config;
}

export function createLLMService(): LLMPort {
  const remoteConfig = createRemoteConfigFromEnv();
  const remote = remoteConfig ? new RemoteLLM(remoteConfig) : null;

  const isRemoteEmbed = !!process.env.QMD_EMBED_PROVIDER || !!process.env.QMD_SILICONFLOW_API_KEY || !!process.env.QMD_OPENAI_API_KEY;

  type ProviderName = "siliconflow" | "gemini" | "openai" | "dashscope";
  const providerHealth = new Map<ProviderName, { consecutiveFailures: number; cooldownUntilMs: number }>();
  const FAILURE_THRESHOLD = 3;
  const COOLDOWN_MS = 5 * 60 * 1000;

  const isCoolingDown = (provider: ProviderName): boolean => {
    const state = providerHealth.get(provider);
    if (!state) return false;
    return Date.now() < state.cooldownUntilMs;
  };

  const recordSuccess = (provider: ProviderName): void => {
    providerHealth.delete(provider);
  };

  const recordFailure = (provider: ProviderName): void => {
    const now = Date.now();
    const state = providerHealth.get(provider);
    const consecutiveFailures = (state?.consecutiveFailures ?? 0) + 1;
    const isThreshold = consecutiveFailures >= FAILURE_THRESHOLD;
    const cooldownUntilMs = isThreshold ? now + COOLDOWN_MS : (state?.cooldownUntilMs ?? 0);
    providerHealth.set(provider, { consecutiveFailures: isThreshold ? 0 : consecutiveFailures, cooldownUntilMs });
  };

  const hasRemoteProviderKey = (provider: ProviderName): boolean => {
    if (!remoteConfig) return false;
    if (provider === "siliconflow") return !!remoteConfig.siliconflow?.apiKey;
    if (provider === "gemini") return !!remoteConfig.gemini?.apiKey;
    if (provider === "openai") return !!remoteConfig.openai?.apiKey;
    return !!remoteConfig.dashscope?.apiKey;
  };

  return {
    async withSession<T>(fn: (session?: ILLMSession) => Promise<T>, opts?: { maxDuration?: number; name?: string }): Promise<T> {
      if (remote && isRemoteEmbed) {
        return fn(undefined);
      }
      return withLLMSession(async (session) => fn(session), {
        maxDuration: opts?.maxDuration ?? 10 * 60 * 1000,
        name: opts?.name ?? "llm-service",
      });
    },

    async expandQuery(query: string, options?: ExpandOptions, session?: ILLMSession): Promise<Queryable[]> {
      const includeLexical = options?.includeLexical ?? true;
      const context = options?.context;
      const provider = (remoteConfig?.queryExpansionProvider || remoteConfig?.rerankProvider) as ProviderName | undefined;
      if (remote && !session && provider && hasRemoteProviderKey(provider) && (process.env.QMD_QUERY_EXPANSION_PROVIDER || process.env.QMD_EMBED_PROVIDER || process.env.QMD_OPENAI_API_KEY)) {
        if (isCoolingDown(provider)) {
          // skip remote during cooldown
        } else {
          try {
            const out = await remote.expandQuery(query, { includeLexical, context });
            recordSuccess(provider);
            return out;
          } catch (err) {
            recordFailure(provider);
          }
        }
      }
      if (session) {
        return session.expandQuery(query, { includeLexical, context });
      }
      return getDefaultLlamaCpp().expandQuery(query, { includeLexical, context });
    },

    async rerank(query: string, documents: RerankDocument[], session?: ILLMSession): Promise<{ file: string; score: number; extract?: string }[]> {
      const provider = remoteConfig?.rerankProvider as ProviderName | undefined;
      if (remote && provider && hasRemoteProviderKey(provider)) {
        if (!isCoolingDown(provider)) {
          try {
            const result = await remote.rerank(query, documents);
            recordSuccess(provider);
            return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
          } catch (err) {
            recordFailure(provider);
          }
        }
      }
      const result = session
        ? await session.rerank(query, documents)
        : await getDefaultLlamaCpp().rerank(query, documents);
      return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
    },

    async embed(text: string, options?: { model?: string; isQuery?: boolean }, session?: ILLMSession): Promise<{ embedding: number[] }> {
      const provider = remoteConfig?.embedProvider as ProviderName | undefined;
      if (remote && isRemoteEmbed && provider && hasRemoteProviderKey(provider)) {
        if (!isCoolingDown(provider)) {
          try {
            const result = await remote.embed(text, options);
            if (!result) throw new Error("Remote embedding returned null");
            recordSuccess(provider);
            return result;
          } catch (err) {
            recordFailure(provider);
          }
        }
      }
      if (session) {
        const result = await session.embed(text, options);
        if (!result) throw new Error("Session embedding returned null");
        return result;
      }
      const result = await getDefaultLlamaCpp().embed(text, options);
      if (!result) throw new Error("Local embedding returned null");
      return result;
    },
  };
}
