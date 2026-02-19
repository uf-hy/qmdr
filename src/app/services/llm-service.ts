import {
  RemoteLLM,
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

  const ensureRemote = (): RemoteLLM => {
    if (!remote) {
      throw new Error(
        "No remote LLM configured. Set at least one API key (e.g. QMD_SILICONFLOW_API_KEY / QMD_OPENAI_API_KEY / QMD_GEMINI_API_KEY / QMD_DASHSCOPE_API_KEY)."
      );
    }
    return remote;
  };

  return {
    async withSession<T>(fn: (session?: ILLMSession) => Promise<T>, opts?: { maxDuration?: number; name?: string }): Promise<T> {
      void opts;
      return fn(undefined);
    },

    async expandQuery(query: string, options?: ExpandOptions, session?: ILLMSession): Promise<Queryable[]> {
      void session;
      const includeLexical = options?.includeLexical ?? true;
      const context = options?.context;
      const provider = (remoteConfig?.queryExpansionProvider || remoteConfig?.rerankProvider) as ProviderName | undefined;
      const llm = ensureRemote();

      // Query expansion is best-effort: on cooldown or failure, degrade to lexical-only.
      const lexicalFallback = (): Queryable[] => (includeLexical ? [{ type: "lex", text: query }] : []);

      if (provider && hasRemoteProviderKey(provider) && (process.env.QMD_QUERY_EXPANSION_PROVIDER || process.env.QMD_EMBED_PROVIDER || process.env.QMD_OPENAI_API_KEY)) {
        if (isCoolingDown(provider)) {
          return lexicalFallback();
        }
        try {
          const out = await llm.expandQuery(query, { includeLexical, context });
          recordSuccess(provider);
          return out;
        } catch (err) {
          recordFailure(provider);
          return lexicalFallback();
        }
      }

      return lexicalFallback();
    },

    async rerank(query: string, documents: RerankDocument[], session?: ILLMSession): Promise<{ file: string; score: number; extract?: string }[]> {
      void session;
      const provider = remoteConfig?.rerankProvider as ProviderName | undefined;
      const llm = ensureRemote();

      if (provider) {
        if (!hasRemoteProviderKey(provider)) {
          throw new Error(`Remote rerank provider "${provider}" is selected but its API key is missing.`);
        }
        if (isCoolingDown(provider)) {
          throw new Error(`Remote provider "${provider}" is cooling down. Please retry later.`);
        }
        try {
          const result = await llm.rerank(query, documents);
          recordSuccess(provider);
          return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
        } catch (err) {
          recordFailure(provider);
          throw err;
        }
      }

      const result = await llm.rerank(query, documents);
      return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
    },

    async embed(text: string, options?: { model?: string; isQuery?: boolean }, session?: ILLMSession): Promise<{ embedding: number[] }> {
      void session;
      const provider = remoteConfig?.embedProvider as ProviderName | undefined;
      const llm = ensureRemote();

      if (provider) {
        if (!hasRemoteProviderKey(provider)) {
          throw new Error(`Remote embed provider "${provider}" is selected but its API key is missing.`);
        }
        if (isCoolingDown(provider)) {
          throw new Error(`Remote provider "${provider}" is cooling down. Please retry later.`);
        }
        try {
          const result = await llm.embed(text, options);
          if (!result) throw new Error("Remote embedding returned null");
          recordSuccess(provider);
          return result;
        } catch (err) {
          recordFailure(provider);
          throw err;
        }
      }

      const result = await llm.embed(text, options);
      if (!result) throw new Error("Remote embedding returned null");
      return result;
    },
  };
}
