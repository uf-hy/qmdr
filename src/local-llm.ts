import { homedir } from "os";
import { join, resolve, sep } from "path";
import {
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "fs";
import type {
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  ILLMSession,
  LLMSessionOptions,
  LLM,
  ModelInfo,
  QueryType,
  Queryable,
  RerankDocument,
  RerankDocumentResult,
  RerankOptions,
  RerankResult,
} from "./llm.js";

// Lazy-load node-llama-cpp only when local models are actually needed.
let _llamaCpp: any = null;
async function getLlamaCpp() {
  if (!_llamaCpp) {
    try {
      _llamaCpp = await import("node-llama-cpp");
    } catch (e) {
      throw new Error(
        "node-llama-cpp is not available. Use remote providers (QMD_EMBED_PROVIDER=siliconflow) or install node-llama-cpp."
      );
    }
  }
  return _llamaCpp;
}
const getLlama = (...args: any[]) => getLlamaCpp().then((m) => m.getLlama(...args));
const resolveModelFile = (...args: any[]) => getLlamaCpp().then((m) => m.resolveModelFile(...args));
const LlamaLogLevel = { warn: 2, error: 3, debug: 0, info: 1 } as any;
type Llama = any;
type LlamaModel = any;
type LlamaEmbeddingContext = any;
type LlamaToken = any;
let LlamaChatSession: any = null;
// Lazy-init LlamaChatSession only when actually needed (avoid eager import crash on Linux CI)
async function ensureLlamaChatSession() {
  if (!LlamaChatSession) {
    try {
      const m = await getLlamaCpp();
      LlamaChatSession = m.LlamaChatSession;
    } catch {}
  }
  return LlamaChatSession;
}

// =============================================================================
// Model Configuration
// =============================================================================

// HuggingFace model URIs for node-llama-cpp
// Format: hf:<user>/<repo>/<file>
const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_RERANK_MODEL = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
// const DEFAULT_GENERATE_MODEL = "hf:ggml-org/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf";
const DEFAULT_GENERATE_MODEL = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";

export const DEFAULT_EMBED_MODEL_URI = DEFAULT_EMBED_MODEL;
export const DEFAULT_RERANK_MODEL_URI = DEFAULT_RERANK_MODEL;
export const DEFAULT_GENERATE_MODEL_URI = DEFAULT_GENERATE_MODEL;

// Local model cache directory
const MODEL_CACHE_DIR = join(homedir(), ".cache", "qmd", "models");
export const DEFAULT_MODEL_CACHE_DIR = MODEL_CACHE_DIR;

export type PullResult = {
  model: string;
  path: string;
  sizeBytes: number;
  refreshed: boolean;
};

type HfRef = {
  repo: string;
  file: string;
};

function parseHfUri(model: string): HfRef | null {
  if (!model.startsWith("hf:")) return null;
  const without = model.slice(3);
  const parts = without.split("/");
  if (parts.length < 3) return null;
  const repo = parts.slice(0, 2).join("/");
  const file = parts.slice(2).join("/");
  return { repo, file };
}

async function getRemoteEtag(ref: HfRef): Promise<string | null> {
  const url = `https://huggingface.co/${ref.repo}/resolve/main/${ref.file}`;
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return null;
    const etag = resp.headers.get("etag");
    return etag || null;
  } catch {
    return null;
  }
}

export async function pullModels(
  models: string[],
  options: { refresh?: boolean; cacheDir?: string } = {}
): Promise<PullResult[]> {
  const cacheDir = options.cacheDir || MODEL_CACHE_DIR;
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  const results: PullResult[] = [];
  for (const model of models) {
    let refreshed = false;
    const hfRef = parseHfUri(model);
    const filename = model.split("/").pop();

    const deleteCandidate = (candidate: string | null | undefined): boolean => {
      if (!candidate) return false;
      const abs = resolve(candidate);
      const absCache = resolve(cacheDir) + sep;
      if (!abs.startsWith(absCache)) return false;
      if (!existsSync(abs)) return false;
      unlinkSync(abs);
      return true;
    };

    let remoteEtag: string | null = null;
    if (hfRef && filename) {
      const etagPath = join(cacheDir, `${filename}.etag`);
      const pathMapPath = join(cacheDir, `${filename}.path`);
      remoteEtag = await getRemoteEtag(hfRef);

      const localEtag = existsSync(etagPath) ? readFileSync(etagPath, "utf-8").trim() : null;
      const mappedPath = existsSync(pathMapPath) ? readFileSync(pathMapPath, "utf-8").trim() : null;

      // Keep local cache when remote ETag cannot be fetched (offline/HEAD blocked).
      const shouldRefresh =
        options.refresh === true || (remoteEtag !== null && localEtag !== null && remoteEtag !== localEtag);

      if (shouldRefresh) {
        // Delete only confirmed local files; do not call resolveModelFile() here (may download).
        if (deleteCandidate(mappedPath)) refreshed = true;

        // Back-compat: if cache uses URI basename, delete it too.
        if (deleteCandidate(join(cacheDir, filename))) refreshed = true;

        if (existsSync(etagPath)) unlinkSync(etagPath);
        if (existsSync(pathMapPath)) unlinkSync(pathMapPath);
      }
    } else if (options.refresh && filename) {
      if (deleteCandidate(join(cacheDir, filename))) refreshed = true;
    }

    const path = await resolveModelFile(model, cacheDir);
    const sizeBytes = existsSync(path) ? statSync(path).size : 0;
    if (hfRef && filename) {
      const pathMapPath = join(cacheDir, `${filename}.path`);
      writeFileSync(pathMapPath, path + "\n", "utf-8");
      if (remoteEtag) {
        const etagPath = join(cacheDir, `${filename}.etag`);
        writeFileSync(etagPath, remoteEtag + "\n", "utf-8");
      }
    }
    results.push({ model, path, sizeBytes, refreshed });
  }
  return results;
}

// =============================================================================
// Local LLM Implementation
// =============================================================================

export type LlamaCppConfig = {
  embedModel?: string;
  generateModel?: string;
  rerankModel?: string;
  modelCacheDir?: string;
  /**
   * Inactivity timeout in ms before unloading contexts (default: 2 minutes, 0 to disable).
   *
   * Per node-llama-cpp lifecycle guidance, we prefer keeping models loaded and only disposing
   * contexts when idle, since contexts (and their sequences) are the heavy per-session objects.
   * @see https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
   */
  inactivityTimeoutMs?: number;
  /**
   * Whether to dispose models on inactivity (default: false).
   *
   * Keeping models loaded avoids repeated VRAM thrash; set to true only if you need aggressive
   * memory reclaim.
   */
  disposeModelsOnInactivity?: boolean;
};

// Default inactivity timeout: 5 minutes (keep models warm during typical search sessions)
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export class LlamaCpp implements LLM {
  private llama: Llama | null = null;
  private embedModel: LlamaModel | null = null;
  private embedContext: LlamaEmbeddingContext | null = null;
  private generateModel: LlamaModel | null = null;
  private rerankModel: LlamaModel | null = null;
  private rerankContext: Awaited<ReturnType<LlamaModel["createRankingContext"]>> | null = null;

  private embedModelUri: string;
  private generateModelUri: string;
  private rerankModelUri: string;
  private modelCacheDir: string;

  // Ensure we don't load the same model/context concurrently (which can allocate duplicate VRAM).
  private embedModelLoadPromise: Promise<LlamaModel> | null = null;
  private embedContextCreatePromise: Promise<LlamaEmbeddingContext> | null = null;
  private generateModelLoadPromise: Promise<LlamaModel> | null = null;
  private rerankModelLoadPromise: Promise<LlamaModel> | null = null;

  // Inactivity timer for auto-unloading models
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimeoutMs: number;
  private disposeModelsOnInactivity: boolean;

  // Track disposal state to prevent double-dispose
  private disposed = false;

  constructor(config: LlamaCppConfig = {}) {
    this.embedModelUri = config.embedModel || DEFAULT_EMBED_MODEL;
    this.generateModelUri = config.generateModel || DEFAULT_GENERATE_MODEL;
    this.rerankModelUri = config.rerankModel || DEFAULT_RERANK_MODEL;
    this.modelCacheDir = config.modelCacheDir || MODEL_CACHE_DIR;
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.disposeModelsOnInactivity = config.disposeModelsOnInactivity ?? false;
  }

  /**
   * Reset the inactivity timer. Called after each model operation.
   * When timer fires, models are unloaded to free memory (if no active sessions).
   */
  private touchActivity(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.inactivityTimeoutMs > 0 && this.hasLoadedContexts()) {
      this.inactivityTimer = setTimeout(() => {
        if (typeof canUnloadLLM === "function" && !canUnloadLLM()) {
          this.touchActivity();
          return;
        }
        this.unloadIdleResources().catch((err) => {
          console.error("Error unloading idle resources:", err);
        });
      }, this.inactivityTimeoutMs);
      this.inactivityTimer.unref();
    }
  }

  private hasLoadedContexts(): boolean {
    return !!(this.embedContext || this.rerankContext);
  }

  async unloadIdleResources(): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.embedContext) {
      await this.embedContext.dispose();
      this.embedContext = null;
    }
    if (this.rerankContext) {
      await this.rerankContext.dispose();
      this.rerankContext = null;
    }

    if (this.disposeModelsOnInactivity) {
      if (this.embedModel) {
        await this.embedModel.dispose();
        this.embedModel = null;
      }
      if (this.generateModel) {
        await this.generateModel.dispose();
        this.generateModel = null;
      }
      if (this.rerankModel) {
        await this.rerankModel.dispose();
        this.rerankModel = null;
      }
      this.embedModelLoadPromise = null;
      this.generateModelLoadPromise = null;
      this.rerankModelLoadPromise = null;
    }
  }

  private ensureModelCacheDir(): void {
    if (!existsSync(this.modelCacheDir)) {
      mkdirSync(this.modelCacheDir, { recursive: true });
    }
  }

  private async ensureLlama(): Promise<Llama> {
    if (!this.llama) {
      this.llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }
    return this.llama;
  }

  private async resolveModel(modelUri: string): Promise<string> {
    this.ensureModelCacheDir();
    return await resolveModelFile(modelUri, this.modelCacheDir);
  }

  private async ensureEmbedModel(): Promise<LlamaModel> {
    if (this.embedModel) {
      return this.embedModel;
    }
    if (this.embedModelLoadPromise) {
      return await this.embedModelLoadPromise;
    }

    this.embedModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.embedModelUri);
      const model = await llama.loadModel({ modelPath });
      this.embedModel = model;
      this.touchActivity();
      return model;
    })();

    try {
      return await this.embedModelLoadPromise;
    } finally {
      this.embedModelLoadPromise = null;
    }
  }

  private async ensureEmbedContext(): Promise<LlamaEmbeddingContext> {
    if (!this.embedContext) {
      if (this.embedContextCreatePromise) {
        return await this.embedContextCreatePromise;
      }

      this.embedContextCreatePromise = (async () => {
        const model = await this.ensureEmbedModel();
        const context = await model.createEmbeddingContext();
        this.embedContext = context;
        return context;
      })();

      try {
        const context = await this.embedContextCreatePromise;
        this.touchActivity();
        return context;
      } finally {
        this.embedContextCreatePromise = null;
      }
    }
    this.touchActivity();
    return this.embedContext;
  }

  private async ensureGenerateModel(): Promise<LlamaModel> {
    if (!this.generateModel) {
      if (this.generateModelLoadPromise) {
        return await this.generateModelLoadPromise;
      }

      this.generateModelLoadPromise = (async () => {
        const llama = await this.ensureLlama();
        const modelPath = await this.resolveModel(this.generateModelUri);
        const model = await llama.loadModel({ modelPath });
        this.generateModel = model;
        return model;
      })();

      try {
        await this.generateModelLoadPromise;
      } finally {
        this.generateModelLoadPromise = null;
      }
    }
    this.touchActivity();
    if (!this.generateModel) {
      throw new Error("Generate model not loaded");
    }
    return this.generateModel;
  }

  private async ensureRerankModel(): Promise<LlamaModel> {
    if (this.rerankModel) {
      return this.rerankModel;
    }
    if (this.rerankModelLoadPromise) {
      return await this.rerankModelLoadPromise;
    }

    this.rerankModelLoadPromise = (async () => {
      const llama = await this.ensureLlama();
      const modelPath = await this.resolveModel(this.rerankModelUri);
      const model = await llama.loadModel({ modelPath });
      this.rerankModel = model;
      this.touchActivity();
      return model;
    })();

    try {
      return await this.rerankModelLoadPromise;
    } finally {
      this.rerankModelLoadPromise = null;
    }
  }

  private async ensureRerankContext(): Promise<Awaited<ReturnType<LlamaModel["createRankingContext"]>>> {
    if (!this.rerankContext) {
      const model = await this.ensureRerankModel();
      this.rerankContext = await model.createRankingContext();
    }
    this.touchActivity();
    return this.rerankContext;
  }

  async tokenize(text: string): Promise<readonly LlamaToken[]> {
    await this.ensureEmbedContext();
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.tokenize(text);
  }

  async countTokens(text: string): Promise<number> {
    const tokens = await this.tokenize(text);
    return tokens.length;
  }

  async detokenize(tokens: readonly LlamaToken[]): Promise<string> {
    await this.ensureEmbedContext();
    if (!this.embedModel) {
      throw new Error("Embed model not loaded");
    }
    return this.embedModel.detokenize(tokens);
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<EmbeddingResult | null> {
    void options;
    this.touchActivity();

    try {
      const context = await this.ensureEmbedContext();
      const embedding = await context.getEmbeddingFor(text);

      return {
        embedding: Array.from(embedding.vector),
        model: this.embedModelUri,
      };
    } catch (error) {
      console.error("Embedding error:", error);
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    this.touchActivity();
    if (texts.length === 0) return [];

    try {
      const context = await this.ensureEmbedContext();

      const embeddings: (EmbeddingResult | null)[] = await Promise.all(
        texts.map(async (text) => {
          try {
            const embedding = await context.getEmbeddingFor(text);
            this.touchActivity();
            return {
              embedding: Array.from(embedding.vector, (value) => Number(value)),
              model: this.embedModelUri,
            };
          } catch (err) {
            console.error("Embedding error for text:", err);
            return null;
          }
        })
      );

      return embeddings;
    } catch (error) {
      console.error("Batch embedding error:", error);
      return texts.map(() => null);
    }
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<GenerateResult | null> {
    this.touchActivity();

    const ChatSession = await ensureLlamaChatSession();
    if (!ChatSession) {
      throw new Error("LlamaChatSession is not available. Ensure node-llama-cpp is installed.");
    }

    await this.ensureGenerateModel();

    const context = await this.generateModel!.createContext();
    const sequence = context.getSequence();
    const session = new ChatSession({ contextSequence: sequence });

    const maxTokens = options.maxTokens ?? 150;
    const temperature = options.temperature ?? 0.7;

    let result = "";
    try {
      await session.prompt(prompt, {
        maxTokens,
        temperature,
        topK: 20,
        topP: 0.8,
        onTextChunk: (text: string) => {
          result += text;
        },
      });

      return {
        text: result,
        model: this.generateModelUri,
        done: true,
      };
    } finally {
      await context.dispose();
    }
  }

  async modelExists(modelUri: string): Promise<ModelInfo> {
    if (modelUri.startsWith("hf:")) {
      return { name: modelUri, exists: true };
    }

    const exists = existsSync(modelUri);
    return {
      name: modelUri,
      exists,
      path: exists ? modelUri : undefined,
    };
  }

  async expandQuery(
    query: string,
    options: { context?: string; includeLexical?: boolean } = {}
  ): Promise<Queryable[]> {
    this.touchActivity();

    const llama = await this.ensureLlama();
    const ChatSession = await ensureLlamaChatSession();
    if (!ChatSession) {
      throw new Error("LlamaChatSession is not available. Ensure node-llama-cpp is installed.");
    }
    await this.ensureGenerateModel();

    const includeLexical = options.includeLexical ?? true;
    const context = options.context;
    void context;

    const grammar = await llama.createGrammar({
      grammar: `
        root ::= line+
        line ::= type ": " content "\\n"
        type ::= "lex" | "vec" | "hyde"
        content ::= [^\\n]+
      `,
    });

    const prompt = `/no_think Expand this search query: ${query}`;

    const genContext = await this.generateModel!.createContext();
    const sequence = genContext.getSequence();
    const session = new ChatSession({ contextSequence: sequence });

    try {
      const result: string = await session.prompt(prompt, {
        grammar,
        maxTokens: 600,
        temperature: 0.7,
        topK: 20,
        topP: 0.8,
        repeatPenalty: {
          lastTokens: 64,
          presencePenalty: 0.5,
        },
      });

      const lines: string[] = result.trim().split("\n");
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);

      const hasQueryTerm = (text: string): boolean => {
        const lower = text.toLowerCase();
        if (queryTerms.length === 0) return true;
        return queryTerms.some((term) => lower.includes(term));
      };

      const queryables: Queryable[] = lines
        .map((line: string) => {
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) return null;
          const type = line.slice(0, colonIdx).trim();
          if (type !== "lex" && type !== "vec" && type !== "hyde") return null;
          const text = line.slice(colonIdx + 1).trim();
          if (!hasQueryTerm(text)) return null;
          return { type: type as QueryType, text };
        })
        .filter((q: Queryable | null): q is Queryable => q !== null);

      const filtered = includeLexical ? queryables : queryables.filter((q) => q.type !== "lex");
      if (filtered.length > 0) return filtered;

      const fallback: Queryable[] = [
        { type: "hyde", text: `Information about ${query}` },
        { type: "lex", text: query },
        { type: "vec", text: query },
      ];
      return includeLexical ? fallback : fallback.filter((q) => q.type !== "lex");
    } catch (error) {
      console.error("Structured query expansion failed:", error);
      const fallback: Queryable[] = [{ type: "vec", text: query }];
      if (includeLexical) fallback.unshift({ type: "lex", text: query });
      return fallback;
    } finally {
      await genContext.dispose();
    }
  }

  async rerank(query: string, documents: RerankDocument[], options: RerankOptions = {}): Promise<RerankResult> {
    void options;
    this.touchActivity();

    const context = await this.ensureRerankContext();

    // Documents can have duplicate text; preserve one-to-many mapping.
    const textToDocs = new Map<string, Array<{ file: string; index: number }>>();
    documents.forEach((doc, index) => {
      const arr = textToDocs.get(doc.text) || [];
      arr.push({ file: doc.file, index });
      textToDocs.set(doc.text, arr);
    });

    const texts = documents.map((doc) => doc.text);

    type RankedItem = { document: string; score: number };
    const ranked = (await context.rankAndSort(query, texts)) as RankedItem[];

    const results: RerankDocumentResult[] = ranked.map((item: RankedItem) => {
      const candidates = textToDocs.get(item.document);
      const docInfo = candidates && candidates.length > 0 ? candidates.shift()! : null;
      if (!docInfo) {
        // Shouldn't happen unless rankAndSort returns a string not present in the input.
        throw new Error("Rerank produced a document that was not in the input set");
      }
      return {
        file: docInfo.file,
        score: item.score,
        index: docInfo.index,
      };
    });

    return {
      results,
      model: this.rerankModelUri,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    if (this.llama) {
      const disposePromise = this.llama.dispose();
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 1000));
      await Promise.race([disposePromise, timeoutPromise]);
    }

    this.embedContext = null;
    this.rerankContext = null;
    this.embedModel = null;
    this.generateModel = null;
    this.rerankModel = null;
    this.llama = null;

    this.embedModelLoadPromise = null;
    this.embedContextCreatePromise = null;
    this.generateModelLoadPromise = null;
    this.rerankModelLoadPromise = null;
  }
}

// =============================================================================
// Session Management Layer
// =============================================================================

class LLMSessionManager {
  private llm: LlamaCpp;
  private _activeSessionCount = 0;
  private _inFlightOperations = 0;

  constructor(llm: LlamaCpp) {
    this.llm = llm;
  }

  get activeSessionCount(): number {
    return this._activeSessionCount;
  }

  get inFlightOperations(): number {
    return this._inFlightOperations;
  }

  canUnload(): boolean {
    return this._activeSessionCount === 0 && this._inFlightOperations === 0;
  }

  acquire(): void {
    this._activeSessionCount++;
  }

  release(): void {
    this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
  }

  operationStart(): void {
    this._inFlightOperations++;
  }

  operationEnd(): void {
    this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
  }

  getLlamaCpp(): LlamaCpp {
    return this.llm;
  }
}

export class SessionReleasedError extends Error {
  constructor(message = "LLM session has been released or aborted") {
    super(message);
    this.name = "SessionReleasedError";
  }
}

class LLMSession implements ILLMSession {
  private manager: LLMSessionManager;
  private released = false;
  private abortController: AbortController;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(manager: LLMSessionManager, options: LLMSessionOptions = {}) {
    this.manager = manager;
    this.name = options.name || "unnamed";
    this.abortController = new AbortController();

    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            this.abortController.abort(options.signal!.reason);
          },
          { once: true }
        );
      }
    }

    const maxDuration = options.maxDuration ?? 10 * 60 * 1000;
    if (maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        this.abortController.abort(
          new Error(`Session "${this.name}" exceeded max duration of ${maxDuration}ms`)
        );
      }, maxDuration);
      this.maxDurationTimer.unref();
    }

    this.manager.acquire();
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  release(): void {
    if (this.released) return;
    this.released = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.abortController.abort(new Error("Session released"));
    this.manager.release();
  }

  private async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }

    this.manager.operationStart();
    try {
      if (this.abortController.signal.aborted) {
        throw new SessionReleasedError(this.abortController.signal.reason?.message || "Session aborted");
      }
      return await fn();
    } finally {
      this.manager.operationEnd();
    }
  }

  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.withOperation(() => this.manager.getLlamaCpp().embed(text, options));
  }

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().embedBatch(texts));
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean }
  ): Promise<Queryable[]> {
    return this.withOperation(() => this.manager.getLlamaCpp().expandQuery(query, options));
  }

  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    return this.withOperation(() => this.manager.getLlamaCpp().rerank(query, documents, options));
  }
}

let defaultSessionManager: LLMSessionManager | null = null;

function getSessionManager(): LLMSessionManager {
  const llm = getDefaultLlamaCpp();
  if (!defaultSessionManager || defaultSessionManager.getLlamaCpp() !== llm) {
    defaultSessionManager = new LLMSessionManager(llm);
  }
  return defaultSessionManager;
}

export async function withLLMSession<T>(
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions
): Promise<T> {
  const manager = getSessionManager();
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

export function canUnloadLLM(): boolean {
  if (!defaultSessionManager) return true;
  return defaultSessionManager.canUnload();
}

let defaultLlamaCpp: LlamaCpp | null = null;

export function getDefaultLlamaCpp(): LlamaCpp {
  if (!defaultLlamaCpp) {
    defaultLlamaCpp = new LlamaCpp();
  }
  return defaultLlamaCpp;
}

export function setDefaultLlamaCpp(llm: LlamaCpp | null): void {
  defaultLlamaCpp = llm;
}

export async function disposeDefaultLlamaCpp(): Promise<void> {
  if (defaultLlamaCpp) {
    await defaultLlamaCpp.dispose();
    defaultLlamaCpp = null;
  }
}
