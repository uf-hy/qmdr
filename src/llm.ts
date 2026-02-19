/**
 * llm.ts - LLM abstraction layer for QMD
 */


import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format for embeddinggemma.
 */
export function formatQueryForEmbedding(query: string): string {
  return `task: search result | query: ${query}`;
}

/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields.
 */
export function formatDocForEmbedding(text: string, title?: string): string {
  return `title: ${title || "none"} | text: ${text}`;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Token with log probability
 */
export type TokenLogProb = {
  token: string;
  logprob: number;
};

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Generation result with optional logprobs
 */
export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

/**
 * Rerank result for a single document
 */
export type RerankDocumentResult = {
  file: string;
  score: number;
  index: number;
  /** LLM-extracted relevant content (only present when using LLM rerank mode) */
  extract?: string;
};

/**
 * Batch rerank result
 */
export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

/**
 * Model info
 */
export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

/**
 * Options for embedding
 */
export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
  /** Override remote timeout for this operation (ms). */
  timeoutMs?: number;
};

/**
 * Options for text generation
 */
export type GenerateOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Override remote timeout for this operation (ms). */
  timeoutMs?: number;
};

/**
 * Options for reranking
 */
export type RerankOptions = {
  model?: string;
  /** Override remote timeout for this operation (ms). */
  timeoutMs?: number;
};

/**
 * Options for LLM sessions
 */
export type LLMSessionOptions = {
  /** Max session duration in ms (default: 10 minutes) */
  maxDuration?: number;
  /** External abort signal */
  signal?: AbortSignal;
  /** Debug name for logging */
  name?: string;
};

/**
 * Session interface for scoped LLM access with lifecycle guarantees
 */
export interface ILLMSession {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]>;
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]>;
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
  /** Whether this session is still valid (not released or aborted) */
  readonly isValid: boolean;
  /** Abort signal for this session (aborts on release or maxDuration) */
  readonly signal: AbortSignal;
}

/**
 * Supported query types for different search backends
 */
export type QueryType = 'lex' | 'vec' | 'hyde';

/**
 * A single query and its target backend type
 */
export type Queryable = {
  type: QueryType;
  text: string;
};

/**
 * Document to rerank
 */
export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};

// =============================================================================
// LLM Interface
// =============================================================================

/**
 * Abstract LLM interface - implement this for different backends
 */
export interface LLM {
  /**
   * Get embeddings for text
   */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /**
   * Generate text completion
   */
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;

  /**
   * Check if a model exists/is available
   */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Expand a search query into multiple variations for different backends.
   * Returns a list of Queryable objects.
   */
  expandQuery(query: string, options?: { context?: string, includeLexical?: boolean }): Promise<Queryable[]>;

  /**
   * Rerank documents by relevance to a query
   * Returns list of documents with relevance scores (higher = more relevant)
   */
  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}

export type RemoteLLMConfig = {
  rerankProvider: 'siliconflow' | 'gemini' | 'openai' | 'dashscope';
  rerankMode?: 'llm' | 'rerank'; // 'llm' = chat model, 'rerank' = dedicated rerank API
  embedProvider?: 'siliconflow' | 'openai'; // remote embedding provider (optional)
  queryExpansionProvider?: 'siliconflow' | 'gemini' | 'openai'; // remote query expansion (optional)
  /** Optional per-operation timeouts (ms). */
  timeoutsMs?: {
    embed?: number;
    rerank?: number;
    generate?: number;
  };
  siliconflow?: {
    apiKey: string;
    baseUrl?: string; // default: https://api.siliconflow.cn/v1
    model?: string; // default: BAAI/bge-reranker-v2-m3
    embedModel?: string; // default: BAAI/bge-m3
    queryExpansionModel?: string; // default: Qwen/Qwen3-8B
  };
  gemini?: {
    apiKey: string;
    baseUrl?: string; // default: https://generativelanguage.googleapis.com
    model?: string; // default: gemini-2.5-flash
  };
  openai?: {
    apiKey: string;
    baseUrl?: string; // default: https://api.openai.com/v1
    model?: string; // default: gpt-4o-mini (for rerank/query expansion)
    embedModel?: string; // default: text-embedding-3-small
  };
  dashscope?: {
    apiKey: string;
    baseUrl?: string; // default: https://dashscope.aliyuncs.com/compatible-api/v1
    model?: string; // default: qwen3-rerank
  };
};

/**
 * Remote fetch with:
 * - Timeout (AbortController)
 * - Exponential backoff retry with jitter (maxAttempts default: 3)
 * - Better errors (provider/op + HTTP status + response snippet)
 * - Keep-alive hint header
 */
async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: {
    provider: string;
    operation: "embed" | "rerank" | "generate";
    timeoutMs?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
  },
): Promise<Response> {
  const provider = opts.provider;
  const operation = opts.operation;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = Math.max(50, opts.baseDelayMs ?? 500);

  const DEFAULT_TIMEOUTS_MS = {
    embed: 30_000,
    rerank: 15_000,
    generate: 60_000,
  } as const;

  const envTimeoutMs = (() => {
    const raw = process.env.QMD_TIMEOUT_MS;
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.round(parsed);
  })();

  const timeoutMs = Math.max(
    1,
    Math.round(
      opts.timeoutMs
        ?? envTimeoutMs
        ?? (operation === "embed"
          ? DEFAULT_TIMEOUTS_MS.embed
          : operation === "rerank"
            ? DEFAULT_TIMEOUTS_MS.rerank
            : DEFAULT_TIMEOUTS_MS.generate)
    )
  );

  const url = (() => {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  })();

  const isRetryableStatus = (status: number): boolean =>
    status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);

  const getRetryAfterMs = (resp: Response): number | undefined => {
    const raw = resp.headers.get("retry-after");
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isFinite(date)) return undefined;
    const diff = date - Date.now();
    return diff > 0 ? diff : undefined;
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const backoffDelayMs = (attempt: number): number => {
    const exp = Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.random() * baseDelayMs;
    return Math.min(30_000, Math.round(baseDelayMs * exp + jitter));
  };

  const readBodySnippet = async (resp: Response, limit = 500): Promise<string> => {
    try {
      const text = await resp.text();
      const trimmed = text.trim();
      if (!trimmed) return "";
      return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
    } catch {
      return "";
    }
  };

  const initWithKeepAlive: RequestInit | undefined = init
    ? {
      ...init,
      headers: (() => {
        const headers = new Headers(init.headers);
        if (!headers.has("connection")) headers.set("Connection", "keep-alive");
        return headers;
      })(),
    }
    : init;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

    if (initWithKeepAlive?.signal) {
      const parent = initWithKeepAlive.signal;
      if (parent.aborted) {
        controller.abort(parent.reason);
      } else {
        parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
      }
    }

    let resp: Response | null = null;
    let fetchErr: unknown = null;

    try {
      resp = await fetch(input, { ...(initWithKeepAlive || {}), signal: controller.signal });
    } catch (err) {
      fetchErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (resp) {
      if (resp.ok) return resp;

      const status = resp.status;
      const snippet = await readBodySnippet(resp);
      const msg = `[${provider}] ${operation} failed (HTTP ${status}) ${url}${snippet ? ` — ${snippet}` : ""}`;

      const retryable = isRetryableStatus(status);
      if (!retryable || attempt === maxAttempts) {
        throw new Error(msg);
      }

      const retryAfterMs = getRetryAfterMs(resp);
      const delayMs = Math.max(retryAfterMs ?? 0, backoffDelayMs(attempt));
      process.stderr.write(`${msg}\nRetrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...\n`);
      await sleep(delayMs);
      continue;
    }

    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const msg = `[${provider}] ${operation} error ${url} — ${errMsg}`;

    if (attempt === maxAttempts) {
      throw new Error(msg);
    }

    const delayMs = backoffDelayMs(attempt);
    process.stderr.write(`${msg}\nRetrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...\n`);
    await sleep(delayMs);
  }

  throw new Error(`[${provider}] ${operation} failed: exhausted retries`);
}

// =============================================================================
// Rerank prompt: loads from ~/.config/qmd/rerank-prompt.txt if it exists,
// otherwise uses the built-in default. Edit the file to iterate on the prompt
// without touching code — takes effect on the next search.
//
// The file supports two placeholders:
//   {{query}}     → replaced with the user's search query
//   {{documents}} → replaced with the numbered candidate documents
// =============================================================================

const DEFAULT_RERANK_PROMPT = `你是记忆检索助手。根据查询从候选文档中筛选并提取相关信息。

查询：{{query}}

候选文档：
{{documents}}

规则：
1. 只提取与查询直接相关的文档内容，忽略不相关的
2. 每篇用 [编号] 开头，后面跟提取的核心内容
3. 用纯文本输出，不要JSON，不要markdown格式符
4. 没有相关文档则输出 NONE
5. 多篇文档内容相同或高度重复时，只提取第一篇，跳过后续重复
6. 优先选择原始数据源（如日记、笔记、配置记录），跳过「对话/搜索会话记录」类文档——即包含 memory_search、tool_use、tool_result、assistant回复搜索结果 等痕迹的文档，这些是之前搜索产生的二手转述，不是一手信息

示例格式：
[0] 提取的核心内容
[3] 另一篇的核心内容`;

function buildRerankPrompt(query: string, docsText: string): string {
  const configDir = process.env.QMD_CONFIG_DIR || join(homedir(), ".config", "qmd");
  const promptPath = join(configDir, "rerank-prompt.txt");
  let template = DEFAULT_RERANK_PROMPT;
  try {
    if (existsSync(promptPath)) {
      template = readFileSync(promptPath, "utf-8");
    }
  } catch { /* ignore read errors, use default */ }
  return template.replace(/\{\{query\}\}/g, query).replace(/\{\{documents\}\}/g, docsText);
}

export class RemoteLLM implements LLM {
  private readonly config: RemoteLLMConfig;

  constructor(config: RemoteLLMConfig) {
    this.config = config;
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    if (this.config.embedProvider === 'siliconflow') {
      return this.embedWithSiliconflow(text, options);
    }
    if (this.config.embedProvider === 'openai') {
      return this.embedWithOpenAI(text, options);
    }
    throw new Error("RemoteLLM.embed() requires embedProvider='siliconflow' or 'openai'.");
  }

  async generate(_prompt: string, _options?: GenerateOptions): Promise<GenerateResult | null> {
    throw new Error("RemoteLLM.generate() is not implemented. Use local LlamaCpp for generation.");
  }

  async modelExists(_model: string): Promise<ModelInfo> {
    throw new Error("RemoteLLM.modelExists() is not implemented.");
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    if (this.config.queryExpansionProvider === 'siliconflow') {
      return this.expandQueryWithSiliconflow(query, options);
    }
    if (this.config.queryExpansionProvider === 'gemini') {
      return this.expandQueryWithGemini(query, options);
    }
    if (this.config.queryExpansionProvider === 'openai') {
      return this.expandQueryWithOpenAI(query, options);
    }
    // Fallback: simple expansion without LLM
    const includeLexical = options?.includeLexical ?? true;
    const fallback: Queryable[] = [
      { type: 'vec', text: query },
      { type: 'hyde', text: `Information about ${query}` },
    ];
    if (includeLexical) fallback.unshift({ type: 'lex', text: query });
    return fallback;
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {}
  ): Promise<RerankResult> {
    if (this.config.rerankProvider === 'siliconflow') {
      // LLM mode: use SiliconFlow's OpenAI-compatible chat API for reranking
      if (this.config.rerankMode === 'llm') {
        // Build a temporary openai-like config from siliconflow settings
        const sf = this.config.siliconflow;
        if (!sf?.apiKey) throw new Error("SiliconFlow API key required for LLM rerank");
        const openaiOverride = {
          apiKey: sf.apiKey,
          baseUrl: (sf.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/$/, ""),
          model: sf.queryExpansionModel || "zai-org/GLM-4.5-Air",
        };
        return this.rerankWithOpenAI(query, documents, options, openaiOverride, "siliconflow");
      }
      return this.rerankWithSiliconflow(query, documents, options);
    }
    if (this.config.rerankProvider === 'dashscope') {
      return this.rerankWithDashscope(query, documents, options);
    }
    if (this.config.rerankProvider === 'openai') {
      return this.rerankWithOpenAI(query, documents, options);
    }
    return this.rerankWithGemini(query, documents, options);
  }

  async dispose(): Promise<void> {
    // No-op: RemoteLLM has no local resources to dispose.
  }

  // =========================================================================
  // Remote Embedding
  // =========================================================================

  private async embedWithSiliconflow(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const sf = this.config.siliconflow;
    if (!sf?.apiKey) {
      throw new Error("RemoteLLM siliconflow.apiKey is required for remote embedding.");
    }
    const baseUrl = (sf.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
    const model = sf.embedModel || "Qwen/Qwen3-Embedding-8B";

    try {
      const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sf.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          encoding_format: "float",
        }),
      }, { provider: "siliconflow", operation: "embed", timeoutMs: options?.timeoutMs ?? this.config.timeoutsMs?.embed });

      const data = await resp.json() as {
        data?: Array<{ embedding: number[] }>;
        model?: string;
      };

      const embedding = data.data?.[0]?.embedding;
      if (!embedding) return null;

      return { embedding, model: data.model || model };
    } catch (err) {
      console.error("SiliconFlow embed error:", err);
      return null;
    }
  }

  /**
   * Batch embed multiple texts efficiently via SiliconFlow.
   * SiliconFlow supports batch input natively.
   */
  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (this.config.embedProvider === 'openai') {
      return this.embedBatchWithOpenAI(texts);
    }
    if (this.config.embedProvider !== 'siliconflow') {
      throw new Error("RemoteLLM.embedBatch() requires embedProvider='siliconflow' or 'openai'.");
    }
    if (texts.length === 0) return [];

    const sf = this.config.siliconflow;
    if (!sf?.apiKey) {
      throw new Error("RemoteLLM siliconflow.apiKey is required for remote embedding.");
    }
    const baseUrl = (sf.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
    const model = sf.embedModel || "Qwen/Qwen3-Embedding-8B";

    // SiliconFlow supports up to ~64 texts per batch, chunk if needed
    const BATCH_SIZE = 32;
    const allResults: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sf.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: batch,
            encoding_format: "float",
          }),
        }, { provider: "siliconflow", operation: "embed", timeoutMs: this.config.timeoutsMs?.embed });

        const data = await resp.json() as {
          data?: Array<{ embedding: number[]; index: number }>;
          model?: string;
        };

        for (const item of data.data || []) {
          const globalIdx = i + (item.index ?? 0);
          if (globalIdx < texts.length) {
            allResults[globalIdx] = {
              embedding: item.embedding,
              model: data.model || model,
            };
          }
        }
      } catch (err) {
        console.error(`SiliconFlow batch embed error at offset ${i}:`, err);
      }
    }

    return allResults;
  }

  // =========================================================================
  // Remote Query Expansion
  // =========================================================================

  private async expandQueryWithSiliconflow(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    const sf = this.config.siliconflow;
    if (!sf?.apiKey) {
      throw new Error("RemoteLLM siliconflow.apiKey is required for query expansion.");
    }
    const baseUrl = (sf.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
    const model = sf.queryExpansionModel || "zai-org/GLM-4.5-Air";
    const includeLexical = options?.includeLexical ?? true;

    const prompt = [
      "Expand this search query into exactly 3 lines (no more, no less):",
      "lex: keyword terms (space-separated, not a sentence)",
      "vec: semantic search query",
      "hyde: hypothetical document snippet",
      "",
      `Query: ${query}`,
    ].join("\n");

    try {
      const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sf.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        }),
      }, { provider: "siliconflow", operation: "generate", timeoutMs: this.config.timeoutsMs?.generate });

      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content || "";
      return this.parseExpansionResult(text, query, includeLexical);
    } catch (err) {
      console.error("SiliconFlow query expansion error:", err);
      return this.fallbackExpansion(query, includeLexical);
    }
  }

  private async expandQueryWithGemini(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    const gm = this.config.gemini;
    if (!gm?.apiKey) {
      throw new Error("RemoteLLM gemini.apiKey is required for query expansion.");
    }
    const baseUrl = (gm.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const model = gm.model || "gemini-2.5-flash";
    const includeLexical = options?.includeLexical ?? true;

    const prompt = [
      "Expand this search query into exactly 3 lines (no more, no less):",
      "lex: keyword terms (space-separated, not a sentence)",
      "vec: semantic search query",
      "hyde: hypothetical document snippet",
      "",
      `Query: ${query}`,
    ].join("\n");

    try {
      const resp = await fetchWithRetry(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: {
          "x-goog-api-key": gm.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
        }),
      }, { provider: "gemini", operation: "generate", timeoutMs: this.config.timeoutsMs?.generate });

      const data = await resp.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return this.parseExpansionResult(text, query, includeLexical);
    } catch (err) {
      console.error("Gemini query expansion error:", err);
      return this.fallbackExpansion(query, includeLexical);
    }
  }

  private parseExpansionResult(text: string, query: string, includeLexical: boolean): Queryable[] {
    const lines = text.trim().split("\n");
    const queryables: Queryable[] = lines.map(line => {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) return null;
      const type = line.slice(0, colonIdx).trim().toLowerCase();
      if (type !== 'lex' && type !== 'vec' && type !== 'hyde') return null;
      const content = line.slice(colonIdx + 1).trim();
      if (!content) return null;
      return { type: type as QueryType, text: content };
    }).filter((q): q is Queryable => q !== null);

    const filtered = includeLexical ? queryables : queryables.filter(q => q.type !== 'lex');
    if (filtered.length > 0) return filtered;
    return this.fallbackExpansion(query, includeLexical);
  }

  private fallbackExpansion(query: string, includeLexical: boolean): Queryable[] {
    const fallback: Queryable[] = [
      { type: 'vec', text: query },
      { type: 'hyde', text: `Information about ${query}` },
    ];
    if (includeLexical) fallback.unshift({ type: 'lex', text: query });
    return fallback;
  }

  private async rerankWithSiliconflow(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions
  ): Promise<RerankResult> {
    const sf = this.config.siliconflow;
    if (!sf?.apiKey) {
      throw new Error("RemoteLLM siliconflow.apiKey is required when rerankProvider is 'siliconflow'.");
    }

    const baseUrl = (sf.baseUrl || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
    const model = options.model || sf.model || "BAAI/bge-reranker-v2-m3";

    const resp = await fetchWithRetry(`${baseUrl}/rerank`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sf.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: documents.map((d) => d.text),
        top_n: Math.max(1, documents.length),
      }),
    }, { provider: "siliconflow", operation: "rerank", timeoutMs: options.timeoutMs ?? this.config.timeoutsMs?.rerank });

    const data = await resp.json() as {
      results?: Array<{ index: number; relevance_score: number }>;
    };

    const results: RerankDocumentResult[] = (data.results || [])
      .map((item) => {
        const doc = documents[item.index];
        if (!doc) return null;
        return {
          file: doc.file,
          score: item.relevance_score,
          index: item.index,
        };
      })
      .filter((item): item is RerankDocumentResult => item !== null);

    return {
      results,
      model,
    };
  }

  private async rerankWithDashscope(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions
  ): Promise<RerankResult> {
    const ds = this.config.dashscope;
    if (!ds?.apiKey) {
      throw new Error("RemoteLLM dashscope.apiKey is required when rerankProvider is 'dashscope'.");
    }

    const baseUrl = (ds.baseUrl || "https://dashscope.aliyuncs.com/compatible-api/v1").replace(/\/$/, "");
    const model = options.model || ds.model || "qwen3-rerank";

    const resp = await fetchWithRetry(`${baseUrl}/reranks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents: documents.map((d) => d.text),
        top_n: Math.max(1, documents.length),
      }),
    }, { provider: "dashscope", operation: "rerank", timeoutMs: options.timeoutMs ?? this.config.timeoutsMs?.rerank });

    const data = await resp.json() as {
      results?: Array<{ index: number; relevance_score: number }>;
    };

    const results: RerankDocumentResult[] = (data.results || [])
      .map((item) => {
        const doc = documents[item.index];
        if (!doc) return null;
        return {
          file: doc.file,
          score: item.relevance_score,
          index: item.index,
        };
      })
      .filter((item): item is RerankDocumentResult => item !== null);

    return {
      results,
      model,
    };
  }

  private async rerankWithGemini(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions
  ): Promise<RerankResult> {
    const gm = this.config.gemini;
    if (!gm?.apiKey) {
      throw new Error("RemoteLLM gemini.apiKey is required when rerankProvider is 'gemini'.");
    }

    const baseUrl = (gm.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const model = options.model || gm.model || "gemini-2.5-flash";

    const docsText = documents.map((doc, i) => `[${i}] ${doc.text}`).join("\n---\n");
    const prompt = buildRerankPrompt(query, docsText);

    const resp = await fetchWithRetry(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": gm.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    }, { provider: "gemini", operation: "rerank", timeoutMs: options.timeoutMs ?? this.config.timeoutsMs?.rerank });

    const data = await resp.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse plain-text format: [0] extracted content\n[3] another extract
    const parsed = this.parsePlainTextExtracts(rawText, documents.length);

    if (parsed.length === 0 && rawText.trim() !== "NONE") {
      process.stderr.write(`Gemini rerank: unexpected response format: ${rawText.slice(0, 200)}\n`);
    }

    const results: RerankDocumentResult[] = [];
    for (let rank = 0; rank < parsed.length; rank++) {
      const item = parsed[rank]!;
      const doc = documents[item.index];
      if (!doc) continue;
      results.push({
        file: doc.file,
        // Score based on LLM's selection order (first = most relevant)
        score: 1.0 - rank * 0.05,
        index: item.index,
        extract: item.extract || undefined,
      });
    }

    return {
      results,
      model,
    };
  }

  /**
   * Parse plain-text extract format: "[0] content\n[3] content"
   * Much more robust than JSON — no escaping issues with special characters.
   */
  private parsePlainTextExtracts(text: string, maxIndex: number): Array<{ index: number; extract: string }> {
    const results: Array<{ index: number; extract: string }> = [];
    const trimmed = text.trim();
    if (!trimmed || trimmed === "NONE") return results;

    // Split by lines starting with [number]
    const segments = trimmed.split(/(?=^\[\d+\])/m);
    for (const segment of segments) {
      const match = segment.match(/^\[(\d+)\]\s*([\s\S]*)/);
      if (!match) continue;
      const index = parseInt(match[1]!, 10);
      const extract = match[2]!.trim();
      if (index >= 0 && index < maxIndex && extract.length > 0) {
        results.push({ index, extract });
      }
    }
    return results;
  }

  private async rerankWithOpenAI(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions,
    openaiOverride?: { apiKey: string; baseUrl?: string; model?: string },
    providerName: string = "openai"
  ): Promise<RerankResult> {
    const oa = openaiOverride || this.config.openai;
    if (!oa?.apiKey) {
      throw new Error("RemoteLLM openai.apiKey is required when rerankProvider is 'openai'.");
    }

    const baseUrl = (oa.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = options.model || oa.model || "gpt-4o-mini";

    const docsText = documents.map((doc, i) => `[${i}] ${doc.text}`).join("\n---\n");
    const prompt = [
      "你是记忆检索助手。根据查询从候选文档中筛选并提取相关信息。",
      "",
      `查询：${query}`,
      "",
      "候选文档：",
      docsText,
      "",
      "规则：",
      "1. 只提取与查询直接相关的文档内容，忽略不相关的",
      "2. 每篇用 [编号] 开头，后面跟提取的核心内容",
      "3. 用纯文本输出，不要JSON，不要markdown格式符",
      "4. 没有相关文档则输出 NONE",
      "5. 多篇文档内容相同或高度重复时，只提取第一篇，跳过后续重复",
      "6. 优先选择原始数据源（如日记、笔记、配置记录），跳过「对话/搜索会话记录」类文档",
      "",
      "示例格式：",
      "[0] 提取的核心内容",
      "[3] 另一篇的核心内容",
    ].join("\n");

    const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oa.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 2000,
      }),
    }, { provider: providerName, operation: "rerank", timeoutMs: options.timeoutMs ?? this.config.timeoutsMs?.rerank });

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content || "";

    const parsed = this.parsePlainTextExtracts(rawText, documents.length);

    if (parsed.length === 0 && rawText.trim() !== "NONE") {
      process.stderr.write(`OpenAI rerank: unexpected response format: ${rawText.slice(0, 200)}\n`);
    }

    const results: RerankDocumentResult[] = [];
    for (let rank = 0; rank < parsed.length; rank++) {
      const item = parsed[rank]!;
      const doc = documents[item.index];
      if (!doc) continue;
      results.push({
        file: doc.file,
        score: 1.0 - rank * 0.05,
        index: item.index,
        extract: item.extract || undefined,
      });
    }

    return { results, model };
  }

  private async embedWithOpenAI(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    const oa = this.config.openai;
    if (!oa?.apiKey) {
      throw new Error("RemoteLLM openai.apiKey is required for remote embedding.");
    }
    const baseUrl = (oa.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = options?.model || oa.embedModel || "text-embedding-3-small";

    const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oa.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text }),
    }, { provider: "openai", operation: "embed", timeoutMs: options?.timeoutMs ?? this.config.timeoutsMs?.embed });

    const data = await resp.json() as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) return null;
    return { embedding, model };
  }

  private async embedBatchWithOpenAI(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const oa = this.config.openai;
    if (!oa?.apiKey) {
      throw new Error("RemoteLLM openai.apiKey is required for remote embedding.");
    }
    const baseUrl = (oa.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = oa.embedModel || "text-embedding-3-small";

    const BATCH_SIZE = 32;
    const allResults: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const resp = await fetchWithRetry(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${oa.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: batch }),
        }, { provider: "openai", operation: "embed", timeoutMs: this.config.timeoutsMs?.embed });

        const data = await resp.json() as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };
        for (const item of data.data || []) {
          const idx = item.index ?? 0;
          if (item.embedding && idx + i < allResults.length) {
            allResults[i + idx] = { embedding: item.embedding, model };
          }
        }
      } catch (err) {
        process.stderr.write(`OpenAI embedBatch error: ${err}\n`);
      }
    }
    return allResults;
  }

  private async expandQueryWithOpenAI(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    const oa = this.config.openai;
    if (!oa?.apiKey) {
      throw new Error("RemoteLLM openai.apiKey is required for query expansion.");
    }
    const baseUrl = (oa.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = oa.model || "gpt-4o-mini";
    const includeLexical = options?.includeLexical ?? true;

    const prompt = [
      "Expand this search query into exactly 3 lines (no more, no less):",
      "lex: keyword terms (space-separated, not a sentence)",
      "vec: semantic search query",
      "hyde: hypothetical document snippet",
      "",
      `Query: ${query}`,
    ].join("\n");

    try {
      const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oa.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        }),
      }, { provider: "openai", operation: "generate", timeoutMs: this.config.timeoutsMs?.generate });

      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content || "";
      return this.parseExpansionResult(text, query, includeLexical);
    } catch (err) {
      console.error(`OpenAI query expansion error: ${err}`);
      return this.fallbackExpansion(query, includeLexical);
    }
  }

  private extractJsonObject(text: string): unknown {
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/i);
    const candidate = fenced?.[1] || text;

    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error(`Gemini rerank response does not contain valid JSON: ${text}`);
    }

    const jsonText = candidate.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonText);
  }

  private extractJsonArray(text: string): unknown[] {
    // Try to find JSON array, handling cases where content may contain markdown
    // First try: direct bracket matching (more reliable than fenced block extraction)
    const firstBracket = text.indexOf("[");
    const lastBracket = text.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      const jsonText = text.slice(firstBracket, lastBracket + 1);
      try {
        return JSON.parse(jsonText);
      } catch {
        // JSON parse failed, try to fix common issues
      }
    }

    // Fallback: try fenced block extraction
    const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      const candidate = fenced[1];
      const fb = candidate.indexOf("[");
      const lb = candidate.lastIndexOf("]");
      if (fb !== -1 && lb !== -1 && lb > fb) {
        try {
          return JSON.parse(candidate.slice(fb, lb + 1));
        } catch {
          // fall through
        }
      }
    }

    throw new Error(`Response does not contain valid JSON array: ${text.slice(0, 200)}`);
  }
}

export * from "./local-llm.js";
