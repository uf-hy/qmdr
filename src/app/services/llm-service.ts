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
  const rerankProvider = process.env.QMD_RERANK_PROVIDER as "siliconflow" | "gemini" | "openai" | undefined;
  const embedProvider = process.env.QMD_EMBED_PROVIDER as "siliconflow" | "openai" | undefined;
  const queryExpansionProvider = process.env.QMD_QUERY_EXPANSION_PROVIDER as "siliconflow" | "gemini" | "openai" | undefined;
  const rerankMode = (process.env.QMD_RERANK_MODE as "llm" | "rerank" | undefined) || "llm";
  const sfApiKey = process.env.QMD_SILICONFLOW_API_KEY;
  const gmApiKey = process.env.QMD_GEMINI_API_KEY;
  const oaApiKey = process.env.QMD_OPENAI_API_KEY;

  const sfLlmRerankModel = process.env.QMD_SILICONFLOW_LLM_RERANK_MODEL || process.env.QMD_LLM_RERANK_MODEL || "zai-org/GLM-4.5-Air";

  let effectiveRerankProvider: "siliconflow" | "gemini" | "openai" | undefined;
  if (rerankMode === "rerank") {
    if (sfApiKey) {
      effectiveRerankProvider = "siliconflow";
    } else if (rerankProvider === "gemini" && gmApiKey) {
      effectiveRerankProvider = "gemini";
    } else if (rerankProvider === "openai" && oaApiKey) {
      effectiveRerankProvider = "openai";
    } else {
      effectiveRerankProvider = gmApiKey ? "gemini" : (oaApiKey ? "openai" : undefined);
    }
  } else {
    if (rerankProvider === "gemini" || rerankProvider === "openai") {
      effectiveRerankProvider = rerankProvider;
    } else if (rerankProvider === "siliconflow") {
      effectiveRerankProvider = sfApiKey ? "openai" : undefined;
    } else {
      effectiveRerankProvider = sfApiKey ? "openai" : (gmApiKey ? "gemini" : (oaApiKey ? "openai" : undefined));
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

  return config;
}

export function createLLMService(): LLMPort {
  const remoteConfig = createRemoteConfigFromEnv();
  const remote = remoteConfig ? new RemoteLLM(remoteConfig) : null;

  const isRemoteEmbed = !!process.env.QMD_EMBED_PROVIDER || !!process.env.QMD_SILICONFLOW_API_KEY || !!process.env.QMD_OPENAI_API_KEY;

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
      if (remote && !session && (process.env.QMD_QUERY_EXPANSION_PROVIDER || process.env.QMD_EMBED_PROVIDER || process.env.QMD_OPENAI_API_KEY)) {
        return remote.expandQuery(query, { includeLexical, context });
      }
      if (session) {
        return session.expandQuery(query, { includeLexical, context });
      }
      return getDefaultLlamaCpp().expandQuery(query, { includeLexical, context });
    },

    async rerank(query: string, documents: RerankDocument[], session?: ILLMSession): Promise<{ file: string; score: number; extract?: string }[]> {
      if (remote) {
        const result = await remote.rerank(query, documents);
        return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
      }
      const result = session
        ? await session.rerank(query, documents)
        : await getDefaultLlamaCpp().rerank(query, documents);
      return result.results.map(r => ({ file: r.file, score: r.score, extract: r.extract }));
    },

    async embed(text: string, options?: { model?: string; isQuery?: boolean }, session?: ILLMSession): Promise<{ embedding: number[] }> {
      if (remote && isRemoteEmbed) {
        const result = await remote.embed(text, options);
        if (!result) throw new Error("Remote embedding returned null");
        return result;
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
