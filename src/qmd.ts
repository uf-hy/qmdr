#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { Glob, $ } from "bun";
import { parseArgs } from "util";
import { readFileSync, statSync } from "fs";
import * as sqliteVec from "sqlite-vec";
import {
  getPwd,
  getRealPath,
  homedir,
  resolve,
  enableProductionMode,
  searchFTS,
  searchVec,
  extractSnippet,
  getContextForFile,
  getContextForPath,
  listCollections,
  removeCollection,
  renameCollection,
  findSimilarFiles,
  findDocumentByDocid,
  isDocid,
  matchFilesByGlob,
  getHashesNeedingEmbedding,
  getHashesForEmbedding,
  clearAllEmbeddings,
  insertEmbedding,
  isVectorRuntimeAvailable,
  getStatus,
  hashContent,
  extractTitle,
  formatDocForEmbedding,
  formatQueryForEmbedding,
  chunkDocument,
  chunkDocumentByTokens,
  clearCache,
  getCacheKey,
  getCachedResult,
  setCachedResult,
  getIndexHealth,
  parseVirtualPath,
  buildVirtualPath,
  isVirtualPath,
  resolveVirtualPath,
  toVirtualPath,
  insertContent,
  insertDocument,
  findActiveDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  cleanupOrphanedContent,
  deleteLLMCache,
  deleteInactiveDocuments,
  cleanupOrphanedVectors,
  vacuumDatabase,
  getCollectionsWithoutContext,
  getTopLevelPathsWithoutContext,
  handelize,
  DEFAULT_EMBED_MODEL,
  DEFAULT_QUERY_MODEL,
  DEFAULT_RERANK_MODEL,
  DEFAULT_GLOB,
  DEFAULT_MULTI_GET_MAX_BYTES,
  createStore,
  getDefaultDbPath,
} from "./store.js";
import { type ILLMSession, type RerankDocument, type Queryable, type QueryType, RemoteLLM, type RemoteLLMConfig } from "./llm.js";
import type { SearchResult, RankedResult } from "./store.js";
import {
  formatSearchResults,
  formatDocuments,
  escapeXml,
  escapeCSV,
  type OutputFormat,
} from "./formatter.js";
import {
  getCollection as getCollectionFromYaml,
  listCollections as yamlListCollections,
  addContext as yamlAddContext,
  removeContext as yamlRemoveContext,
  setGlobalContext,
  listAllContexts,
  setConfigIndexName,
} from "./collections.js";
import { handleContextCommand } from "./app/commands/context.js";
import { handleGetCommand, handleMultiGetCommand, handleLsCommand } from "./app/commands/document.js";
import { handleCollectionCommand } from "./app/commands/collection.js";
import { handleSearchCommand, handleVSearchCommand, handleQueryCommand } from "./app/commands/search.js";
import { handleCleanupCommand, handleStatusCommand, handleUpdateCommand, handleEmbedCommand, handleMcpCommand, handleDoctorCommand } from "./app/commands/maintenance.js";
import { createLLMService } from "./app/services/llm-service.js";
import { existsSync } from "fs";
import { join } from "path";

// =============================================================================
// Load config from ~/.config/qmd/.env (single source of truth)
//
// QMD_ prefixed vars: .env WINS over inherited environment.
//   → Why: When spawned by OpenClaw, the parent process may carry stale env
//     vars (e.g. QMD_RERANK_PROVIDER=siliconflow from an old /etc/environment).
//     The .env file is the user's explicit config and should be authoritative.
//
// All other vars: inherited environment wins (standard dotenv behavior).
//   → Why: System vars like PATH, HOME, NO_COLOR, XDG_* should be controlled
//     by the parent process / OS, not overridden by a QMD config file.
// =============================================================================

const qmdConfigDir = process.env.QMD_CONFIG_DIR || join(homedir(), ".config", "qmd");
const qmdEnvPath = join(qmdConfigDir, ".env");
if (existsSync(qmdEnvPath)) {
  const envContent = readFileSync(qmdEnvPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key.startsWith("QMD_")) {
      // QMD's own config: .env is the source of truth, always override
      process.env[key] = val;
    } else if (!process.env[key]) {
      // Non-QMD vars: only set if not already present (standard dotenv)
      process.env[key] = val;
    }
  }
}

// Enable production mode - allows using default database path
// Tests must set INDEX_PATH or use createStore() with explicit path
enableProductionMode();

// =============================================================================
// Store/DB lifecycle (no legacy singletons in store.ts)
// =============================================================================

let store: ReturnType<typeof createStore> | null = null;
let storeDbPathOverride: string | undefined;

function getStore(): ReturnType<typeof createStore> {
  if (!store) {
    store = createStore(storeDbPathOverride);
  }
  return store;
}

function getDb(): Database {
  return getStore().db;
}

function closeDb(): void {
  if (store) {
    store.close();
    store = null;
  }
}

function getDbPath(): string {
  return store?.dbPath ?? storeDbPathOverride ?? getDefaultDbPath();
}

function setIndexName(name: string | null): void {
  storeDbPathOverride = name ? getDefaultDbPath(name) : undefined;
  // Reset open handle so next use opens the new index
  closeDb();
}

function ensureVecTable(_db: Database, dimensions: number): void {
  // Store owns the DB; ignore `_db` and ensure vec table on the active store
  getStore().ensureVecTable(dimensions);
}

// Terminal colors (respects NO_COLOR env)
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  green: useColor ? "\x1b[32m" : "",
  magenta: useColor ? "\x1b[35m" : "",
  blue: useColor ? "\x1b[34m" : "",
};

// Terminal cursor control
const cursor = {
  hide() { process.stderr.write('\x1b[?25l'); },
  show() { process.stderr.write('\x1b[?25h'); },
};

// Ensure cursor is restored on exit
process.on('SIGINT', () => { cursor.show(); process.exit(130); });
process.on('SIGTERM', () => { cursor.show(); process.exit(143); });

// Terminal progress bar using OSC 9;4 escape sequence
const progress = {
  set(percent: number) {
    process.stderr.write(`\x1b]9;4;1;${Math.round(percent)}\x07`);
  },
  clear() {
    process.stderr.write(`\x1b]9;4;0\x07`);
  },
  indeterminate() {
    process.stderr.write(`\x1b]9;4;3\x07`);
  },
  error() {
    process.stderr.write(`\x1b]9;4;2\x07`);
  },
};

// Format seconds into human-readable ETA
function formatETA(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}


// Check index health and print warnings/tips
function checkIndexHealth(db: Database): void {
  if (_quietMode) return;
  const { needsEmbedding, totalDocs, daysStale } = getIndexHealth(db);

  // Warn if many docs need embedding
  if (needsEmbedding > 0) {
    const pct = Math.round((needsEmbedding / totalDocs) * 100);
    if (pct >= 10) {
      process.stderr.write(`${c.yellow}Warning: ${needsEmbedding} documents (${pct}%) need embeddings. Run 'qmd embed' for better results.${c.reset}\n`);
    } else {
      process.stderr.write(`${c.dim}Tip: ${needsEmbedding} documents need embeddings. Run 'qmd embed' to index them.${c.reset}\n`);
    }
  }

  // Check if most recent document update is older than 2 weeks
  if (daysStale !== null && daysStale >= 14) {
    process.stderr.write(`${c.dim}Tip: Index last updated ${daysStale} days ago. Run 'qmd update' to refresh.${c.reset}\n`);
  }
}

// Compute unique display path for a document
// Always include at least parent folder + filename, add more parent dirs until unique
function computeDisplayPath(
  filepath: string,
  collectionPath: string,
  existingPaths: Set<string>
): string {
  // Get path relative to collection (include collection dir name)
  const collectionDir = collectionPath.replace(/\/$/, '');
  const collectionName = collectionDir.split('/').pop() || '';

  let relativePath: string;
  if (filepath.startsWith(collectionDir + '/')) {
    // filepath is under collection: use collection name + relative path
    relativePath = collectionName + filepath.slice(collectionDir.length);
  } else {
    // Fallback: just use the filepath
    relativePath = filepath;
  }

  const parts = relativePath.split('/').filter(p => p.length > 0);

  // Always include at least parent folder + filename (minimum 2 parts if available)
  // Then add more parent dirs until unique
  const minParts = Math.min(2, parts.length);
  for (let i = parts.length - minParts; i >= 0; i--) {
    const candidate = parts.slice(i).join('/');
    if (!existingPaths.has(candidate)) {
      return candidate;
    }
  }

  // Absolute fallback: use full path (should be unique)
  return filepath;
}

// Remote LLM instance (initialized from env vars; handles rerank + embed + query expansion)
let remoteLLM: RemoteLLM | null = null;
let _quietMode = false;  // Suppress progress/debug output (set by query command)
const llmService = createLLMService();

function getRemoteLLM(): RemoteLLM | null {
  if (remoteLLM) return remoteLLM;

  // Check env vars for remote config
  const rerankProvider = process.env.QMD_RERANK_PROVIDER as 'siliconflow' | 'gemini' | 'openai' | 'dashscope' | undefined;
  const embedProvider = process.env.QMD_EMBED_PROVIDER as 'siliconflow' | 'openai' | undefined;
  const queryExpansionProvider = process.env.QMD_QUERY_EXPANSION_PROVIDER as 'siliconflow' | 'gemini' | 'openai' | undefined;
  const rerankMode = (process.env.QMD_RERANK_MODE as 'llm' | 'rerank' | undefined) || 'llm';
  const sfApiKey = process.env.QMD_SILICONFLOW_API_KEY;
  const gmApiKey = process.env.QMD_GEMINI_API_KEY;
  const oaApiKey = process.env.QMD_OPENAI_API_KEY;
  const dsApiKey = process.env.QMD_DASHSCOPE_API_KEY;
  const sfLlmRerankModel = process.env.QMD_SILICONFLOW_LLM_RERANK_MODEL || process.env.QMD_LLM_RERANK_MODEL || 'zai-org/GLM-4.5-Air';

  let effectiveRerankProvider: 'siliconflow' | 'gemini' | 'openai' | 'dashscope' | undefined;
  if (rerankMode === 'rerank') {
    if (rerankProvider === 'dashscope' && dsApiKey) {
      effectiveRerankProvider = 'dashscope';
    } else if (sfApiKey) {
      effectiveRerankProvider = 'siliconflow';
    } else if (rerankProvider === 'gemini' && gmApiKey) {
      effectiveRerankProvider = 'gemini';
    } else if (rerankProvider === 'openai' && oaApiKey) {
      effectiveRerankProvider = 'openai';
    } else if (dsApiKey) {
      effectiveRerankProvider = 'dashscope';
    } else {
      effectiveRerankProvider = gmApiKey ? 'gemini' : (oaApiKey ? 'openai' : undefined);
    }
  } else {
    if (rerankProvider === 'dashscope' && dsApiKey) {
      effectiveRerankProvider = 'dashscope';
    } else if (rerankProvider === 'gemini' || rerankProvider === 'openai') {
      effectiveRerankProvider = rerankProvider;
    } else if (rerankProvider === 'siliconflow') {
      // LLM rerank via SiliconFlow's OpenAI-compatible API
      effectiveRerankProvider = 'siliconflow';
    } else {
      effectiveRerankProvider = sfApiKey ? 'siliconflow' : (gmApiKey ? 'gemini' : (oaApiKey ? 'openai' : undefined));
    }
  }
  const effectiveEmbedProvider = embedProvider || (sfApiKey ? 'siliconflow' : (oaApiKey ? 'openai' : undefined));
  const effectiveQueryExpansionProvider = queryExpansionProvider || (sfApiKey ? 'siliconflow' : (oaApiKey ? 'openai' : (gmApiKey ? 'gemini' : undefined)));

  // Need at least one remote provider configured
  if (!effectiveRerankProvider && !effectiveEmbedProvider && !effectiveQueryExpansionProvider) return null;

  const config: RemoteLLMConfig = {
    rerankProvider: effectiveRerankProvider || 'siliconflow',
    rerankMode: rerankMode as 'llm' | 'rerank',
    embedProvider: effectiveEmbedProvider,
    queryExpansionProvider: effectiveQueryExpansionProvider,
  };

  // SiliconFlow config (shared by rerank, embed, query expansion)
  if (sfApiKey) {
    config.siliconflow = {
      apiKey: sfApiKey,
      baseUrl: process.env.QMD_SILICONFLOW_BASE_URL,
      model: process.env.QMD_SILICONFLOW_RERANK_MODEL || process.env.QMD_SILICONFLOW_MODEL,
      embedModel: process.env.QMD_SILICONFLOW_EMBED_MODEL,
      queryExpansionModel: process.env.QMD_SILICONFLOW_QUERY_EXPANSION_MODEL,
    };
  }

  // Gemini config
  if (effectiveRerankProvider === 'gemini' || effectiveQueryExpansionProvider === 'gemini') {
    if (gmApiKey) {
      config.gemini = {
        apiKey: gmApiKey,
        baseUrl: process.env.QMD_GEMINI_BASE_URL,
        model: process.env.QMD_GEMINI_RERANK_MODEL || process.env.QMD_GEMINI_MODEL,
      };
    }
  }

  if (oaApiKey || (effectiveRerankProvider === 'openai' && sfApiKey)) {
    config.openai = {
      apiKey: oaApiKey || sfApiKey || '',
      baseUrl: process.env.QMD_OPENAI_BASE_URL || process.env.QMD_SILICONFLOW_BASE_URL,
      model: process.env.QMD_OPENAI_MODEL || (sfApiKey ? sfLlmRerankModel : undefined),
      embedModel: process.env.QMD_OPENAI_EMBED_MODEL,
    };
  }

  // Dashscope config (Alibaba Bailian — rerank only)
  if (dsApiKey || effectiveRerankProvider === 'dashscope') {
    config.dashscope = {
      apiKey: dsApiKey || '',
      baseUrl: process.env.QMD_DASHSCOPE_BASE_URL,
      model: process.env.QMD_DASHSCOPE_RERANK_MODEL,
    };
  }

  remoteLLM = new RemoteLLM(config);
  return remoteLLM;
}

// Rerank documents using cross-encoder model (local or remote)
async function rerank(query: string, documents: { file: string; text: string }[], _model: string = DEFAULT_RERANK_MODEL, _db?: Database, session?: ILLMSession): Promise<{ file: string; score: number; extract?: string }[]> {
  if (documents.length === 0) return [];

  const total = documents.length;
  if (!_quietMode) {
    const configured = process.env.QMD_RERANK_PROVIDER;
    process.stderr.write(`Reranking ${total} documents${configured ? ` (provider: ${configured})` : ""}...\n`);
    progress.indeterminate();
  }

  const rerankDocs: RerankDocument[] = documents.map((doc) => ({
    file: doc.file,
    text: doc.text.slice(0, 4000), // Truncate to context limit
  }));

  const result = await llmService.rerank(query, rerankDocs, session);

  if (!_quietMode) progress.clear();
  if (!_quietMode) process.stderr.write("\n");

  return result.map((r) => ({ file: r.file, score: r.score, extract: r.extract }));
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function showStatus(): void {
  const dbPath = getDbPath();
  const db = getDb();

  // Collections are defined in YAML; no duplicate cleanup needed.
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Index size
  let indexSize = 0;
  try {
    const stat = statSync(dbPath).size;
    indexSize = stat;
  } catch { }

  // Collections info (from YAML + database stats)
  const collections = listCollections(db);

  // Overall stats
  const totalDocs = db.prepare(`SELECT COUNT(*) as count FROM documents WHERE active = 1`).get() as { count: number };
  const vectorCount = db.prepare(`SELECT COUNT(*) as count FROM content_vectors`).get() as { count: number };
  const needsEmbedding = getHashesNeedingEmbedding(db);

  // Most recent update across all collections
  const mostRecent = db.prepare(`SELECT MAX(modified_at) as latest FROM documents WHERE active = 1`).get() as { latest: string | null };

  console.log(`${c.bold}QMD Status${c.reset}\n`);
  console.log(`Index: ${dbPath}`);
  console.log(`Size:  ${formatBytes(indexSize)}\n`);

  console.log(`${c.bold}Documents${c.reset}`);
  console.log(`  Total:    ${totalDocs.count} files indexed`);
  console.log(`  Vectors:  ${vectorCount.count} embedded`);
  if (needsEmbedding > 0) {
    console.log(`  ${c.yellow}Pending:  ${needsEmbedding} need embedding${c.reset} (run 'qmd embed')`);
  }
  if (mostRecent.latest) {
    const lastUpdate = new Date(mostRecent.latest);
    console.log(`  Updated:  ${formatTimeAgo(lastUpdate)}`);
  }

  // Get all contexts grouped by collection (from YAML)
  const allContexts = listAllContexts();
  const contextsByCollection = new Map<string, { path_prefix: string; context: string }[]>();

  for (const ctx of allContexts) {
    // Group contexts by collection name
    if (!contextsByCollection.has(ctx.collection)) {
      contextsByCollection.set(ctx.collection, []);
    }
    contextsByCollection.get(ctx.collection)!.push({
      path_prefix: ctx.path,
      context: ctx.context
    });
  }

  if (collections.length > 0) {
    console.log(`\n${c.bold}Collections${c.reset}`);
    for (const col of collections) {
      const lastMod = col.last_modified ? formatTimeAgo(new Date(col.last_modified)) : "never";
      const contexts = contextsByCollection.get(col.name) || [];

      console.log(`  ${c.cyan}${col.name}${c.reset} ${c.dim}(qmd://${col.name}/)${c.reset}`);
      console.log(`    ${c.dim}Pattern:${c.reset}  ${col.glob_pattern}`);
      console.log(`    ${c.dim}Files:${c.reset}    ${col.active_count} (updated ${lastMod})`);

      if (contexts.length > 0) {
        console.log(`    ${c.dim}Contexts:${c.reset} ${contexts.length}`);
        for (const ctx of contexts) {
          // Handle both empty string and '/' as root context
          const pathDisplay = (ctx.path_prefix === '' || ctx.path_prefix === '/') ? '/' : `/${ctx.path_prefix}`;
          const contextPreview = ctx.context.length > 60
            ? ctx.context.substring(0, 57) + '...'
            : ctx.context;
          console.log(`      ${c.dim}${pathDisplay}:${c.reset} ${contextPreview}`);
        }
      }
    }

    // Show examples of virtual paths
    console.log(`\n${c.bold}Examples${c.reset}`);
    console.log(`  ${c.dim}# List files in a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd ls ${collections[0].name}`);
    }
    console.log(`  ${c.dim}# Get a document${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd get qmd://${collections[0].name}/path/to/file.md`);
    }
    console.log(`  ${c.dim}# Search within a collection${c.reset}`);
    if (collections.length > 0 && collections[0]) {
      console.log(`  qmd search "query" -c ${collections[0].name}`);
    }
  } else {
    console.log(`\n${c.dim}No collections. Run 'qmd collection add .' to index markdown files.${c.reset}`);
  }

  closeDb();
}

async function updateCollections(allowRun: boolean): Promise<void> {
  const db = getDb();
  // Collections are defined in YAML; no duplicate cleanup needed.

  // Clear OLLAMA cache on update
  clearCache(db);

  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log(`${c.dim}No collections found. Run 'qmd collection add .' to index markdown files.${c.reset}`);
    closeDb();
    return;
  }

  // Don't close db here - indexFiles will reuse it and close at the end
  console.log(`${c.bold}Updating ${collections.length} collection(s)...${c.reset}\n`);

  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    if (!col) continue;
    console.log(`${c.cyan}[${i + 1}/${collections.length}]${c.reset} ${c.bold}${col.name}${c.reset} ${c.dim}(${col.glob_pattern})${c.reset}`);

    // Execute custom update command if specified in YAML
    const yamlCol = getCollectionFromYaml(col.name);
    if (yamlCol?.update) {
      if (!allowRun) {
        console.log(`${c.dim}    Skipping update command (use --allow-run to enable): ${yamlCol.update}${c.reset}`);
        await indexFiles(col.pwd, col.glob_pattern, col.name, true);
        console.log("");
        continue;
      }
      console.log(`${c.dim}    Running update command: ${yamlCol.update}${c.reset}`);
      try {
        const proc = Bun.spawn(["/usr/bin/env", "bash", "-c", yamlCol.update], {
          cwd: col.pwd,
          stdout: "pipe",
          stderr: "pipe",
        });

        const output = await new Response(proc.stdout).text();
        const errorOutput = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (output.trim()) {
          console.log(output.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }
        if (errorOutput.trim()) {
          console.log(errorOutput.trim().split('\n').map(l => `    ${l}`).join('\n'));
        }

        if (exitCode !== 0) {
          console.log(`${c.yellow}✗ Update command failed with exit code ${exitCode}${c.reset}`);
          process.exit(exitCode);
        }
      } catch (err) {
        console.log(`${c.yellow}✗ Update command failed: ${err}${c.reset}`);
        process.exit(1);
      }
    }

    await indexFiles(col.pwd, col.glob_pattern, col.name, true);
    console.log("");
  }

  // Check if any documents need embedding (show once at end)
  const finalDb = getDb();
  const needsEmbedding = getHashesNeedingEmbedding(finalDb);
  closeDb();

  console.log(`${c.green}✓ All collections updated.${c.reset}`);
  if (needsEmbedding > 0) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }
}

/**
 * Detect which collection (if any) contains the given filesystem path.
 * Returns { collectionId, collectionName, relativePath } or null if not in any collection.
 */
function detectCollectionFromPath(db: Database, fsPath: string): { collectionName: string; relativePath: string } | null {
  const realPath = getRealPath(fsPath);

  // Find collections that this path is under from YAML
  const allCollections = yamlListCollections();

  // Find longest matching path
  let bestMatch: { name: string; path: string } | null = null;
  for (const coll of allCollections) {
    if (realPath.startsWith(coll.path + '/') || realPath === coll.path) {
      if (!bestMatch || coll.path.length > bestMatch.path.length) {
        bestMatch = { name: coll.name, path: coll.path };
      }
    }
  }

  if (!bestMatch) return null;

  // Calculate relative path
  let relativePath = realPath;
  if (relativePath.startsWith(bestMatch.path + '/')) {
    relativePath = relativePath.slice(bestMatch.path.length + 1);
  } else if (relativePath === bestMatch.path) {
    relativePath = '';
  }

  return {
    collectionName: bestMatch.name,
    relativePath
  };
}

async function contextAdd(pathArg: string | undefined, contextText: string): Promise<void> {
  const db = getDb();

  // Handle "/" as global context (applies to all collections)
  if (pathArg === '/') {
    setGlobalContext(contextText);
    console.log(`${c.green}✓${c.reset} Set global context`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Resolve path - defaults to current directory if not provided
  let fsPath = pathArg || '.';
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/') && !fsPath.startsWith('qmd://')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  // Handle virtual paths (qmd://collection/path)
  if (isVirtualPath(fsPath)) {
    const parsed = parseVirtualPath(fsPath);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${fsPath}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    yamlAddContext(parsed.collectionName, parsed.path, contextText);

    const displayPath = parsed.path
      ? `qmd://${parsed.collectionName}/${parsed.path}`
      : `qmd://${parsed.collectionName}/ (collection root)`;
    console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
    console.log(`${c.dim}Context: ${contextText}${c.reset}`);
    closeDb();
    return;
  }

  // Detect collection from filesystem path
  const detected = detectCollectionFromPath(db, fsPath);
  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    console.error(`${c.dim}Run 'qmd status' to see indexed collections${c.reset}`);
    process.exit(1);
  }

  yamlAddContext(detected.collectionName, detected.relativePath, contextText);

  const displayPath = detected.relativePath ? `qmd://${detected.collectionName}/${detected.relativePath}` : `qmd://${detected.collectionName}/`;
  console.log(`${c.green}✓${c.reset} Added context for: ${displayPath}`);
  console.log(`${c.dim}Context: ${contextText}${c.reset}`);
  closeDb();
}

function contextList(): void {
  const db = getDb();

  const allContexts = listAllContexts();

  if (allContexts.length === 0) {
    console.log(`${c.dim}No contexts configured. Use 'qmd context add' to add one.${c.reset}`);
    closeDb();
    return;
  }

  console.log(`\n${c.bold}Configured Contexts${c.reset}\n`);

  let lastCollection = '';
  for (const ctx of allContexts) {
    if (ctx.collection !== lastCollection) {
      console.log(`${c.cyan}${ctx.collection}${c.reset}`);
      lastCollection = ctx.collection;
    }

    const displayPath = ctx.path ? `  ${ctx.path}` : '  / (root)';
    console.log(`${displayPath}`);
    console.log(`    ${c.dim}${ctx.context}${c.reset}`);
  }

  closeDb();
}

function contextRemove(pathArg: string): void {
  if (pathArg === '/') {
    // Remove global context
    setGlobalContext(undefined);
    console.log(`${c.green}✓${c.reset} Removed global context`);
    return;
  }

  // Handle virtual paths
  if (isVirtualPath(pathArg)) {
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`${c.yellow}Invalid virtual path: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    const coll = getCollectionFromYaml(parsed.collectionName);
    if (!coll) {
      console.error(`${c.yellow}Collection not found: ${parsed.collectionName}${c.reset}`);
      process.exit(1);
    }

    const success = yamlRemoveContext(coll.name, parsed.path);

    if (!success) {
      console.error(`${c.yellow}No context found for: ${pathArg}${c.reset}`);
      process.exit(1);
    }

    console.log(`${c.green}✓${c.reset} Removed context for: ${pathArg}`);
    return;
  }

  // Handle filesystem paths
  let fsPath = pathArg;
  if (fsPath === '.' || fsPath === './') {
    fsPath = getPwd();
  } else if (fsPath.startsWith('~/')) {
    fsPath = homedir() + fsPath.slice(1);
  } else if (!fsPath.startsWith('/')) {
    fsPath = resolve(getPwd(), fsPath);
  }

  const db = getDb();
  const detected = detectCollectionFromPath(db, fsPath);
  closeDb();

  if (!detected) {
    console.error(`${c.yellow}Path is not in any indexed collection: ${fsPath}${c.reset}`);
    process.exit(1);
  }

  const success = yamlRemoveContext(detected.collectionName, detected.relativePath);

  if (!success) {
    console.error(`${c.yellow}No context found for: qmd://${detected.collectionName}/${detected.relativePath}${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.green}✓${c.reset} Removed context for: qmd://${detected.collectionName}/${detected.relativePath}`);
}

function contextCheck(): void {
  const db = getDb();

  // Get collections without any context
  const collectionsWithoutContext = getCollectionsWithoutContext(db);

  // Get all collections to check for missing path contexts
  const allCollections = listCollections(db);

  if (collectionsWithoutContext.length === 0 && allCollections.length > 0) {
    // Check if all collections have contexts
    console.log(`\n${c.green}✓${c.reset} ${c.bold}All collections have context configured${c.reset}\n`);
  }

  if (collectionsWithoutContext.length > 0) {
    console.log(`\n${c.yellow}Collections without any context:${c.reset}\n`);

    for (const coll of collectionsWithoutContext) {
      console.log(`${c.cyan}${coll.name}${c.reset} ${c.dim}(${coll.doc_count} documents)${c.reset}`);
      console.log(`  ${c.dim}Suggestion: qmd context add qmd://${coll.name}/ "Description of ${coll.name}"${c.reset}\n`);
    }
  }

  // Check for top-level paths without context within collections that DO have context
  const collectionsWithContext = allCollections.filter(c =>
    c && !collectionsWithoutContext.some(cwc => cwc.name === c.name)
  );

  let hasPathSuggestions = false;

  for (const coll of collectionsWithContext) {
    if (!coll) continue;
    const missingPaths = getTopLevelPathsWithoutContext(db, coll.name);

    if (missingPaths.length > 0) {
      if (!hasPathSuggestions) {
        console.log(`${c.yellow}Top-level directories without context:${c.reset}\n`);
        hasPathSuggestions = true;
      }

      console.log(`${c.cyan}${coll.name}${c.reset}`);
      for (const path of missingPaths) {
        console.log(`  ${path}`);
        console.log(`    ${c.dim}Suggestion: qmd context add qmd://${coll.name}/${path} "Description of ${path}"${c.reset}`);
      }
      console.log('');
    }
  }

  if (collectionsWithoutContext.length === 0 && !hasPathSuggestions) {
    console.log(`${c.dim}All collections and major paths have context configured.${c.reset}`);
    console.log(`${c.dim}Use 'qmd context list' to see all configured contexts.${c.reset}\n`);
  }

  closeDb();
}

function getDocument(filename: string, fromLine?: number, maxLines?: number, lineNumbers?: boolean): void {
  const db = getDb();

  // Parse :linenum suffix from filename (e.g., "file.md:100")
  let inputPath = filename;
  const colonMatch = inputPath.match(/:(\d+)$/);
  if (colonMatch && !fromLine) {
    const matched = colonMatch[1];
    if (matched) {
      fromLine = parseInt(matched, 10);
      inputPath = inputPath.slice(0, -colonMatch[0].length);
    }
  }

  // Handle docid lookup (#abc123, abc123, "#abc123", "abc123", etc.)
  if (isDocid(inputPath)) {
    const docidMatch = findDocumentByDocid(db, inputPath);
    if (docidMatch) {
      inputPath = docidMatch.filepath;
    } else {
      console.error(`Document not found: ${filename}`);
      closeDb();
      process.exit(1);
    }
  }

  let doc: { collectionName: string; path: string; body: string } | null = null;
  let virtualPath: string;

  // Handle virtual paths (qmd://collection/path)
  if (isVirtualPath(inputPath)) {
    const parsed = parseVirtualPath(inputPath);
    if (!parsed) {
      console.error(`Invalid virtual path: ${inputPath}`);
      closeDb();
      process.exit(1);
    }

    // Try exact match on collection + path
    doc = db.prepare(`
      SELECT d.collection as collectionName, d.path, content.doc as body
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(parsed.collectionName, parsed.path) as typeof doc;

    if (!doc) {
      // Try fuzzy match by path ending
      doc = db.prepare(`
        SELECT d.collection as collectionName, d.path, content.doc as body
        FROM documents d
        JOIN content ON content.hash = d.hash
        WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
        LIMIT 1
      `).get(parsed.collectionName, `%${parsed.path}`) as typeof doc;
    }

    virtualPath = inputPath;
  } else {
    // Try to interpret as collection/path format first (before filesystem path)
    // If path is relative (no / or ~ prefix), check if first component is a collection name
    if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
      const parts = inputPath.split('/');
      if (parts.length >= 2) {
        const possibleCollection = parts[0];
        const possiblePath = parts.slice(1).join('/');

        // Check if this collection exists
        const collExists = possibleCollection ? db.prepare(`
          SELECT 1 FROM documents WHERE collection = ? AND active = 1 LIMIT 1
        `).get(possibleCollection) : null;

        if (collExists) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT d.collection as collectionName, d.path, content.doc as body
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(possibleCollection || "", possiblePath || "") as { collectionName: string; path: string; body: string } | null;

          if (!doc) {
            // Try fuzzy match by path ending
            doc = db.prepare(`
              SELECT d.collection as collectionName, d.path, content.doc as body
              FROM documents d
              JOIN content ON content.hash = d.hash
              WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
              LIMIT 1
            `).get(possibleCollection || "", `%${possiblePath}`) as { collectionName: string; path: string; body: string } | null;
          }

          if (doc) {
            virtualPath = buildVirtualPath(doc.collectionName, doc.path);
            // Skip the filesystem path handling below
          }
        }
      }
    }

    // If not found as collection/path, handle as filesystem paths
    if (!doc) {
      let fsPath = inputPath;

      // Expand ~ to home directory
      if (fsPath.startsWith('~/')) {
        fsPath = homedir() + fsPath.slice(1);
      } else if (!fsPath.startsWith('/')) {
        // Relative path - resolve from current directory
        fsPath = resolve(getPwd(), fsPath);
      }
      fsPath = getRealPath(fsPath);

      // Try to detect which collection contains this path
      const detected = detectCollectionFromPath(db, fsPath);

      if (detected) {
        // Found collection - query by collection name + relative path
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.collection = ? AND d.path = ? AND d.active = 1
        `).get(detected.collectionName, detected.relativePath) as { collectionName: string; path: string; body: string } | null;
      }

      // Fuzzy match by filename (last component of path)
      if (!doc) {
        const filename = inputPath.split('/').pop() || inputPath;
        doc = db.prepare(`
          SELECT d.collection as collectionName, d.path, content.doc as body
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path LIKE ? AND d.active = 1
          LIMIT 1
        `).get(`%${filename}`) as { collectionName: string; path: string; body: string } | null;
      }

      if (doc) {
        virtualPath = buildVirtualPath(doc.collectionName, doc.path);
      } else {
        virtualPath = inputPath;
      }
    }
  }

  // Ensure doc is not null before proceeding
  if (!doc) {
    console.error(`Document not found: ${filename}`);
    closeDb();
    process.exit(1);
  }

  // Get context for this file
  const context = getContextForPath(db, doc.collectionName, doc.path);

  let output = doc.body;
  const startLine = fromLine || 1;

  // Apply line filtering if specified
  if (fromLine !== undefined || maxLines !== undefined) {
    const lines = output.split('\n');
    const start = startLine - 1; // Convert to 0-indexed
    const end = maxLines !== undefined ? start + maxLines : lines.length;
    output = lines.slice(start, end).join('\n');
  }

  // Add line numbers if requested
  if (lineNumbers) {
    output = addLineNumbers(output, startLine);
  }

  // Output context header if exists
  if (context) {
    console.log(`Folder Context: ${context}\n---\n`);
  }
  console.log(output);
  closeDb();
}

// Multi-get: fetch multiple documents by glob pattern or comma-separated list
function multiGet(pattern: string, maxLines?: number, maxBytes: number = DEFAULT_MULTI_GET_MAX_BYTES, format: OutputFormat = "cli"): void {
  const db = getDb();

  // Check if it's a comma-separated list or a glob pattern
  const isCommaSeparated = pattern.includes(',') && !pattern.includes('*') && !pattern.includes('?');

  let files: { filepath: string; displayPath: string; bodyLength: number; collection?: string; path?: string }[];

  if (isCommaSeparated) {
    // Comma-separated list of files (can be virtual paths or relative paths)
    const names = pattern.split(',').map(s => s.trim()).filter(Boolean);
    files = [];
    for (const name of names) {
      let doc: { virtual_path: string; body_length: number; collection: string; path: string } | null = null;

      // Handle virtual paths
      if (isVirtualPath(name)) {
        const parsed = parseVirtualPath(name);
        if (parsed) {
          // Try exact match on collection + path
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.collection = ? AND d.path = ? AND d.active = 1
          `).get(parsed.collectionName, parsed.path) as typeof doc;
        }
      } else {
        // Try exact match on path
        doc = db.prepare(`
          SELECT
            'qmd://' || d.collection || '/' || d.path as virtual_path,
            LENGTH(content.doc) as body_length,
            d.collection,
            d.path
          FROM documents d
          JOIN content ON content.hash = d.hash
          WHERE d.path = ? AND d.active = 1
          LIMIT 1
        `).get(name) as { virtual_path: string; body_length: number; collection: string; path: string } | null;

        // Try suffix match
        if (!doc) {
          doc = db.prepare(`
            SELECT
              'qmd://' || d.collection || '/' || d.path as virtual_path,
              LENGTH(content.doc) as body_length,
              d.collection,
              d.path
            FROM documents d
            JOIN content ON content.hash = d.hash
            WHERE d.path LIKE ? AND d.active = 1
            LIMIT 1
          `).get(`%${name}`) as { virtual_path: string; body_length: number; collection: string; path: string } | null;
        }
      }

      if (doc) {
        files.push({
          filepath: doc.virtual_path,
          displayPath: doc.virtual_path,
          bodyLength: doc.body_length,
          collection: doc.collection,
          path: doc.path
        });
      } else {
        console.error(`File not found: ${name}`);
      }
    }
  } else {
    // Glob pattern - matchFilesByGlob now returns virtual paths
    files = matchFilesByGlob(db, pattern).map(f => ({
      ...f,
      collection: undefined,  // Will be fetched later if needed
      path: undefined
    }));
    if (files.length === 0) {
      console.error(`No files matched pattern: ${pattern}`);
      closeDb();
      process.exit(1);
    }
  }

  // Collect results for structured output
  const results: { file: string; displayPath: string; title: string; body: string; context: string | null; skipped: boolean; skipReason?: string }[] = [];

  for (const file of files) {
    // Parse virtual path to get collection info if not already available
    let collection = file.collection;
    let path = file.path;

    if (!collection || !path) {
      const parsed = parseVirtualPath(file.filepath);
      if (parsed) {
        collection = parsed.collectionName;
        path = parsed.path;
      }
    }

    // Get context using collection-scoped function
    const context = collection && path ? getContextForPath(db, collection, path) : null;

    // Check size limit
    if (file.bodyLength > maxBytes) {
      results.push({
        file: file.filepath,
        displayPath: file.displayPath,
        title: file.displayPath.split('/').pop() || file.displayPath,
        body: "",
        context,
        skipped: true,
        skipReason: `File too large (${Math.round(file.bodyLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB). Use 'qmd get ${file.displayPath}' to retrieve.`,
      });
      continue;
    }

    // Fetch document content using collection and path
    if (!collection || !path) continue;

    const doc = db.prepare(`
      SELECT content.doc as body, d.title
      FROM documents d
      JOIN content ON content.hash = d.hash
      WHERE d.collection = ? AND d.path = ? AND d.active = 1
    `).get(collection, path) as { body: string; title: string } | null;

    if (!doc) continue;

    let body = doc.body;

    // Apply line limit if specified
    if (maxLines !== undefined) {
      const lines = body.split('\n');
      body = lines.slice(0, maxLines).join('\n');
      if (lines.length > maxLines) {
        body += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
      }
    }

    results.push({
      file: file.filepath,
      displayPath: file.displayPath,
      title: doc.title || file.displayPath.split('/').pop() || file.displayPath,
      body,
      context,
      skipped: false,
    });
  }

  closeDb();

  // Output based on format
  if (format === "json") {
    const output = results.map(r => ({
      file: r.displayPath,
      title: r.title,
      ...(r.context && { context: r.context }),
      ...(r.skipped ? { skipped: true, reason: r.skipReason } : { body: r.body }),
    }));
    console.log(JSON.stringify(output, null, 2));
  } else if (format === "csv") {
    const escapeField = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    console.log("file,title,context,skipped,body");
    for (const r of results) {
      console.log([r.displayPath, r.title, r.context, r.skipped ? "true" : "false", r.skipped ? r.skipReason : r.body].map(escapeField).join(","));
    }
  } else if (format === "files") {
    for (const r of results) {
      const ctx = r.context ? `,"${r.context.replace(/"/g, '""')}"` : "";
      const status = r.skipped ? "[SKIPPED]" : "";
      console.log(`${r.displayPath}${ctx}${status ? `,${status}` : ""}`);
    }
  } else if (format === "md") {
    for (const r of results) {
      console.log(`## ${r.displayPath}\n`);
      if (r.title && r.title !== r.displayPath) console.log(`**Title:** ${r.title}\n`);
      if (r.context) console.log(`**Context:** ${r.context}\n`);
      if (r.skipped) {
        console.log(`> ${r.skipReason}\n`);
      } else {
        console.log("```");
        console.log(r.body);
        console.log("```\n");
      }
    }
  } else if (format === "xml") {
    console.log('<?xml version="1.0" encoding="UTF-8"?>');
    console.log("<documents>");
    for (const r of results) {
      console.log("  <document>");
      console.log(`    <file>${escapeXml(r.displayPath)}</file>`);
      console.log(`    <title>${escapeXml(r.title)}</title>`);
      if (r.context) console.log(`    <context>${escapeXml(r.context)}</context>`);
      if (r.skipped) {
        console.log(`    <skipped>true</skipped>`);
        console.log(`    <reason>${escapeXml(r.skipReason || "")}</reason>`);
      } else {
        console.log(`    <body>${escapeXml(r.body)}</body>`);
      }
      console.log("  </document>");
    }
    console.log("</documents>");
  } else {
    // CLI format (default)
    for (const r of results) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`File: ${r.displayPath}`);
      console.log(`${'='.repeat(60)}\n`);

      if (r.skipped) {
        console.log(`[SKIPPED: ${r.skipReason}]`);
        continue;
      }

      if (r.context) {
        console.log(`Folder Context: ${r.context}\n---\n`);
      }
      console.log(r.body);
    }
  }
}

// List files in virtual file tree
function listFiles(pathArg?: string): void {
  const db = getDb();

  if (!pathArg) {
    // No argument - list all collections
    const yamlCollections = yamlListCollections();

    if (yamlCollections.length === 0) {
      console.log("No collections found. Run 'qmd add .' to index files.");
      closeDb();
      return;
    }

    // Get file counts from database for each collection
    const collections = yamlCollections.map(coll => {
      const stats = db.prepare(`
        SELECT COUNT(*) as file_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { file_count: number } | null;

      return {
        name: coll.name,
        file_count: stats?.file_count || 0
      };
    });

    console.log(`${c.bold}Collections:${c.reset}\n`);
    for (const coll of collections) {
      console.log(`  ${c.dim}qmd://${c.reset}${c.cyan}${coll.name}/${c.reset}  ${c.dim}(${coll.file_count} files)${c.reset}`);
    }
    closeDb();
    return;
  }

  // Parse the path argument
  let collectionName: string;
  let pathPrefix: string | null = null;

  if (pathArg.startsWith('qmd://')) {
    // Virtual path format: qmd://collection/path
    const parsed = parseVirtualPath(pathArg);
    if (!parsed) {
      console.error(`Invalid virtual path: ${pathArg}`);
      closeDb();
      process.exit(1);
    }
    collectionName = parsed.collectionName;
    pathPrefix = parsed.path;
  } else {
    // Just collection name or collection/path
    const parts = pathArg.split('/');
    collectionName = parts[0] || '';
    if (parts.length > 1) {
      pathPrefix = parts.slice(1).join('/');
    }
  }

  // Get the collection
  const coll = getCollectionFromYaml(collectionName);
  if (!coll) {
    console.error(`Collection not found: ${collectionName}`);
    console.error(`Run 'qmd ls' to see available collections.`);
    closeDb();
    process.exit(1);
  }

  // List files in the collection with size and modification time
  let query: string;
  let params: any[];

  if (pathPrefix) {
    // List files under a specific path
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.path LIKE ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name, `${pathPrefix}%`];
  } else {
    // List all files in the collection
    query = `
      SELECT d.path, d.title, d.modified_at, LENGTH(ct.doc) as size
      FROM documents d
      JOIN content ct ON d.hash = ct.hash
      WHERE d.collection = ? AND d.active = 1
      ORDER BY d.path
    `;
    params = [coll.name];
  }

  const files = db.prepare(query).all(...params) as { path: string; title: string; modified_at: string; size: number }[];

  if (files.length === 0) {
    if (pathPrefix) {
      console.log(`No files found under qmd://${collectionName}/${pathPrefix}`);
    } else {
      console.log(`No files found in collection: ${collectionName}`);
    }
    closeDb();
    return;
  }

  // Calculate max widths for alignment
  const maxSize = Math.max(...files.map(f => formatBytes(f.size).length));

  // Output in ls -l style
  for (const file of files) {
    const sizeStr = formatBytes(file.size).padStart(maxSize);
    const date = new Date(file.modified_at);
    const timeStr = formatLsTime(date);

    // Dim the qmd:// prefix, highlight the filename
    console.log(`${sizeStr}  ${timeStr}  ${c.dim}qmd://${collectionName}/${c.reset}${c.cyan}${file.path}${c.reset}`);
  }

  closeDb();
}

// Format date/time like ls -l
function formatLsTime(date: Date): string {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 6 * 30 * 24 * 60 * 60 * 1000);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2, ' ');

  // If file is older than 6 months, show year instead of time
  if (date < sixMonthsAgo) {
    const year = date.getFullYear();
    return `${month} ${day}  ${year}`;
  } else {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  }
}

// Collection management commands
function collectionList(): void {
  const db = getDb();
  const collections = listCollections(db);

  if (collections.length === 0) {
    console.log("No collections found. Run 'qmd add .' to create one.");
    closeDb();
    return;
  }

  console.log(`${c.bold}Collections (${collections.length}):${c.reset}\n`);

  for (const coll of collections) {
    const updatedAt = coll.last_modified ? new Date(coll.last_modified) : new Date();
    const timeAgo = formatTimeAgo(updatedAt);

    console.log(`${c.cyan}${coll.name}${c.reset} ${c.dim}(qmd://${coll.name}/)${c.reset}`);
    console.log(`  ${c.dim}Pattern:${c.reset}  ${coll.glob_pattern}`);
    console.log(`  ${c.dim}Files:${c.reset}    ${coll.active_count}`);
    console.log(`  ${c.dim}Updated:${c.reset}  ${timeAgo}`);
    console.log();
  }

  closeDb();
}

async function collectionAdd(pwd: string, globPattern: string, name?: string): Promise<void> {
  // If name not provided, generate from pwd basename
  let collName = name;
  if (!collName) {
    const parts = pwd.split('/').filter(Boolean);
    collName = parts[parts.length - 1] || 'root';
  }

  // Check if collection with this name already exists in YAML
  const existing = getCollectionFromYaml(collName);
  if (existing) {
    console.error(`${c.yellow}Collection '${collName}' already exists.${c.reset}`);
    console.error(`Use a different name with --name <name>`);
    process.exit(1);
  }

  // Check if a collection with this pwd+glob already exists in YAML
  const allCollections = yamlListCollections();
  const existingPwdGlob = allCollections.find(c => c.path === pwd && c.pattern === globPattern);

  if (existingPwdGlob) {
    console.error(`${c.yellow}A collection already exists for this path and pattern:${c.reset}`);
    console.error(`  Name: ${existingPwdGlob.name} (qmd://${existingPwdGlob.name}/)`);
    console.error(`  Pattern: ${globPattern}`);
    console.error(`\nUse 'qmd update' to re-index it, or remove it first with 'qmd collection remove ${existingPwdGlob.name}'`);
    process.exit(1);
  }

  // Add to YAML config
  const { addCollection } = await import("./collections.js");
  addCollection(collName, pwd, globPattern);

  // Create the collection and index files
  console.log(`Creating collection '${collName}'...`);
  await indexFiles(pwd, globPattern, collName);
  console.log(`${c.green}✓${c.reset} Collection '${collName}' created successfully`);
}

function collectionRemove(name: string): void {
  // Check if collection exists in YAML
  const coll = getCollectionFromYaml(name);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${name}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  const db = getDb();
  const result = removeCollection(db, name);
  closeDb();

  console.log(`${c.green}✓${c.reset} Removed collection '${name}'`);
  console.log(`  Deleted ${result.deletedDocs} documents`);
  if (result.cleanedHashes > 0) {
    console.log(`  Cleaned up ${result.cleanedHashes} orphaned content hashes`);
  }
}

function collectionRename(oldName: string, newName: string): void {
  // Check if old collection exists in YAML
  const coll = getCollectionFromYaml(oldName);
  if (!coll) {
    console.error(`${c.yellow}Collection not found: ${oldName}${c.reset}`);
    console.error(`Run 'qmd collection list' to see available collections.`);
    process.exit(1);
  }

  // Check if new name already exists in YAML
  const existing = getCollectionFromYaml(newName);
  if (existing) {
    console.error(`${c.yellow}Collection name already exists: ${newName}${c.reset}`);
    console.error(`Choose a different name or remove the existing collection first.`);
    process.exit(1);
  }

  const db = getDb();
  renameCollection(db, oldName, newName);
  closeDb();

  console.log(`${c.green}✓${c.reset} Renamed collection '${oldName}' to '${newName}'`);
  console.log(`  Virtual paths updated: ${c.cyan}qmd://${oldName}/${c.reset} → ${c.cyan}qmd://${newName}/${c.reset}`);
}

async function indexFiles(pwd?: string, globPattern: string = DEFAULT_GLOB, collectionName?: string, suppressEmbedNotice: boolean = false): Promise<void> {
  const db = getDb();
  const resolvedPwd = pwd || getPwd();
  const collectionRoot = getRealPath(resolvedPwd).replace(/\\/g, "/");
  const collectionRootPrefix = collectionRoot.endsWith("/") ? collectionRoot : collectionRoot + "/";
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  const defaultMaxIndexBytes = 64 * 1024 * 1024;
  const maxIndexBytesEnv = process.env.QMD_MAX_INDEX_FILE_BYTES;
  let maxIndexBytes = Number.parseInt(maxIndexBytesEnv ?? "", 10);
  if (!Number.isFinite(maxIndexBytes) || maxIndexBytes <= 0) {
    maxIndexBytes = defaultMaxIndexBytes;
  }

  // macOS and Windows are typically case-insensitive; avoid false negatives when
  // realpath casing differs from the collection root.
  function shouldFoldPathCaseForRoot(root: string): boolean {
    if (process.platform === "win32") return true;
    if (process.platform !== "darwin") return false;

    const idx = root.search(/[A-Za-z]/);
    if (idx < 0) return false;

    const ch = root[idx] as string;
    const flipped = root.slice(0, idx) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + root.slice(idx + 1);
    return getRealPath(flipped).replace(/\\/g, "/") === root;
  }

  const foldPathCase = shouldFoldPathCaseForRoot(collectionRoot);
  const collectionRootCmp = foldPathCase ? collectionRoot.toLowerCase() : collectionRoot;
  const collectionRootPrefixCmp = foldPathCase ? collectionRootPrefix.toLowerCase() : collectionRootPrefix;

  // Clear OLLAMA cache on index
  clearCache(db);

  // Collection name must be provided (from YAML)
  if (!collectionName) {
    throw new Error("Collection name is required. Collections must be defined in ~/.config/qmd/index.yml");
  }

  console.log(`Collection: ${resolvedPwd} (${globPattern})`);

  progress.indeterminate();
  const glob = new Glob(globPattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: resolvedPwd, onlyFiles: true, followSymlinks: false })) {
    // Skip node_modules, hidden folders (.*), and other common excludes
    const parts = file.split("/");
    const shouldSkip = parts.some(part =>
      part === "node_modules" ||
      part.startsWith(".") ||
      excludeDirs.includes(part)
    );
    if (!shouldSkip) {
      files.push(file);
    }
  }

  const total = files.length;
  if (total === 0) {
    progress.clear();
    console.log("No files found matching pattern.");
    closeDb();
    return;
  }

  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();
  const normalizedPathMap = new Map<string, string>();
  const startTime = Date.now();
  let skippedSymlinkEscapes = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  let skippedUnreadable = 0;

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(resolvedPwd, relativeFile)).replace(/\\/g, "/");
    const filepathCmp = foldPathCase ? filepath.toLowerCase() : filepath;
    if (!(filepathCmp === collectionRootCmp || filepathCmp.startsWith(collectionRootPrefixCmp))) {
      skippedSymlinkEscapes++;
      processed++;
      progress.set((processed / total) * 100);
      continue;
    }

    const normalizedPath = handelize(relativeFile); // Normalize path for token-friendliness
    const existingOriginal = normalizedPathMap.get(normalizedPath);
    let path = normalizedPath;
    if (existingOriginal && existingOriginal !== relativeFile) {
      path = relativeFile;
      if (seenPaths.has(path)) {
        let counter = 2;
        let candidate = `${path}~${counter}`;
        while (seenPaths.has(candidate)) {
          counter++;
          candidate = `${path}~${counter}`;
        }
        path = candidate;
      }
    } else if (!existingOriginal) {
      normalizedPathMap.set(normalizedPath, relativeFile);
    }
    seenPaths.add(path);

    let stat: { size: number; mtime: Date; birthtime: Date } | null = null;
    try {
      stat = statSync(filepath);
    } catch {
      skippedUnreadable++;
      processed++;
      progress.set((processed / total) * 100);
      continue;
    }

    if (stat.size > maxIndexBytes) {
      skippedTooLarge++;
      processed++;
      progress.set((processed / total) * 100);
      continue;
    }

    let content = "";
    try {
      const buf = readFileSync(filepath) as unknown as Uint8Array;
      // Simple binary detection: skip files containing NUL byte.
      if (buf.includes(0)) {
        skippedBinary++;
        processed++;
        progress.set((processed / total) * 100);
        continue;
      }
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      skippedUnreadable++;
      processed++;
      progress.set((processed / total) * 100);
      continue;
    }

    // Skip empty files - nothing useful to index
    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    // Check if document exists in this collection with this path
    const existing = findActiveDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        // Hash unchanged, but check if title needs updating
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        // Content changed - insert new content hash and update document
        insertContent(db, hash, content, now);
        updateDocument(db, existing.id, title, hash,
          stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
    } else {
      // New document - insert content and document
      indexed++;
      insertContent(db, hash, content, now);
      insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
    }

    processed++;
    progress.set((processed / total) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const remaining = (total - processed) / rate;
    const eta = processed > 2 ? ` ETA: ${formatETA(remaining)}` : "";
    process.stderr.write(`\rIndexing: ${processed}/${total}${eta}        `);
  }

  // Deactivate documents in this collection that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  // Clean up orphaned content hashes (content not referenced by any document)
  const orphanedContent = cleanupOrphanedContent(db);

  // Check if vector index needs updating
  const needsEmbedding = getHashesNeedingEmbedding(db);

  progress.clear();
  console.log(`\nIndexed: ${indexed} new, ${updated} updated, ${unchanged} unchanged, ${removed} removed`);
  if (skippedSymlinkEscapes > 0) {
    console.log(`${c.dim}Skipped ${skippedSymlinkEscapes} symlink-escaped file(s) outside collection root.${c.reset}`);
  }
  if (skippedTooLarge > 0) {
    console.log(`${c.dim}Skipped ${skippedTooLarge} file(s) larger than ${maxIndexBytes} bytes.${c.reset}`);
  }
  if (skippedBinary > 0) {
    console.log(`${c.dim}Skipped ${skippedBinary} binary file(s).${c.reset}`);
  }
  if (skippedUnreadable > 0) {
    console.log(`${c.dim}Skipped ${skippedUnreadable} unreadable/invalid-utf8 file(s).${c.reset}`);
  }
  if (orphanedContent > 0) {
    console.log(`Cleaned up ${orphanedContent} orphaned content hash(es)`);
  }

  if (needsEmbedding > 0 && !suppressEmbedNotice) {
    console.log(`\nRun 'qmd embed' to update embeddings (${needsEmbedding} unique hashes need vectors)`);
  }

  closeDb();
}

function renderProgressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return bar;
}

async function vectorIndex(model: string = DEFAULT_EMBED_MODEL, force: boolean = false): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  // If force, clear all vectors
  if (force) {
    console.log(`${c.yellow}Force re-indexing: clearing all vectors...${c.reset}`);
    clearAllEmbeddings(db);
  }

  // Find unique hashes that need embedding (from active documents)
  const hashesToEmbed = getHashesForEmbedding(db);

  if (hashesToEmbed.length === 0) {
    console.log(`${c.green}✓ All content hashes already have embeddings.${c.reset}`);
    closeDb();
    return;
  }

  // Prepare documents with chunks
  type ChunkItem = { hash: string; title: string; text: string; seq: number; pos: number; tokens: number; bytes: number; displayName: string };
  const allChunks: ChunkItem[] = [];
  let multiChunkDocs = 0;

  // Chunk all documents using actual token counts
  process.stderr.write(`Chunking ${hashesToEmbed.length} documents by token count...\n`);
  for (const item of hashesToEmbed) {
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(item.body).length;
    if (bodyBytes === 0) continue; // Skip empty

    const title = extractTitle(item.body, item.path);
    const displayName = item.path;
    const chunks = await chunkDocumentByTokens(item.body);  // Uses actual tokenizer

    if (chunks.length > 1) multiChunkDocs++;

    for (let seq = 0; seq < chunks.length; seq++) {
      allChunks.push({
        hash: item.hash,
        title,
        text: chunks[seq]!.text, // Chunk is guaranteed to exist by seq loop
        seq,
        pos: chunks[seq]!.pos,
        tokens: chunks[seq]!.tokens,
        bytes: encoder.encode(chunks[seq]!.text).length,
        displayName,
      });
    }
  }

  if (allChunks.length === 0) {
    console.log(`${c.green}✓ No non-empty documents to embed.${c.reset}`);
    closeDb();
    return;
  }

  const totalBytes = allChunks.reduce((sum, chk) => sum + chk.bytes, 0);
  const totalChunks = allChunks.length;
  const totalDocs = hashesToEmbed.length;

  console.log(`${c.bold}Embedding ${totalDocs} documents${c.reset} ${c.dim}(${totalChunks} chunks, ${formatBytes(totalBytes)})${c.reset}`);
  if (multiChunkDocs > 0) {
    console.log(`${c.dim}${multiChunkDocs} documents split into multiple chunks${c.reset}`);
  }
  console.log(`${c.dim}Model: ${model}${c.reset}\n`);

  // Hide cursor during embedding
  cursor.hide();

  const remote = getRemoteLLM();
  if (!remote) {
    cursor.show();
    throw new Error(
      "Remote embedding is not configured. Set QMD_EMBED_PROVIDER and an API key (e.g. QMD_SILICONFLOW_API_KEY or QMD_OPENAI_API_KEY)."
    );
  }

  const effectiveEmbedProvider = (process.env.QMD_EMBED_PROVIDER as 'siliconflow' | 'openai' | undefined)
    || (process.env.QMD_SILICONFLOW_API_KEY ? 'siliconflow' : (process.env.QMD_OPENAI_API_KEY ? 'openai' : undefined));
  if (!effectiveEmbedProvider) {
    cursor.show();
    throw new Error(
      "Remote embedding is not configured. Set QMD_EMBED_PROVIDER (siliconflow|openai) and the corresponding API key."
    );
  }

  const remoteModel = effectiveEmbedProvider === 'openai'
    ? (process.env.QMD_OPENAI_EMBED_MODEL || 'text-embedding-3-small')
    : (process.env.QMD_SILICONFLOW_EMBED_MODEL || 'Qwen/Qwen3-Embedding-8B');
  const providerLabel = effectiveEmbedProvider === 'openai' ? 'OpenAI' : 'SiliconFlow';
  console.log(`${c.dim}Using remote embedding: ${providerLabel}/${remoteModel}${c.reset}\n`);

  // Get embedding dimensions from first chunk
  progress.indeterminate();
  const firstChunk = allChunks[0];
  if (!firstChunk) {
    throw new Error("No chunks available to embed");
  }
  const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title);
  const firstResult = await remote.embed(firstText, { model: remoteModel, isQuery: false });
  if (!firstResult) {
    throw new Error("Failed to get embedding dimensions from remote provider");
  }
  ensureVecTable(db, firstResult.embedding.length);

  let chunksEmbedded = 0, errors = 0, bytesProcessed = 0;
  const startTime = Date.now();
  const BATCH_SIZE = parseInt(process.env.QMD_EMBED_BATCH_SIZE || "32", 10);

  for (let batchStart = 0; batchStart < allChunks.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, allChunks.length);
    const batch = allChunks.slice(batchStart, batchEnd);
    const texts = batch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title));

    try {
      const embeddings = await remote.embedBatch(texts);
      for (let i = 0; i < batch.length; i++) {
        const chunk = batch[i]!;
        const embedding = embeddings[i];
        if (embedding) {
          insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), remoteModel, now);
          chunksEmbedded++;
        } else {
          errors++;
          console.error(`\n${c.yellow}⚠ Error embedding "${chunk.displayName}" chunk ${chunk.seq}${c.reset}`);
        }
        bytesProcessed += chunk.bytes;
      }
    } catch (err) {
      for (const chunk of batch) {
        try {
          const text = formatDocForEmbedding(chunk.text, chunk.title);
          const result = await remote.embed(text, { model: remoteModel, isQuery: false });
          if (result) {
            insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), remoteModel, now);
            chunksEmbedded++;
          } else {
            errors++;
          }
        } catch (innerErr) {
          errors++;
          console.error(`\n${c.yellow}⚠ Error embedding "${chunk.displayName}" chunk ${chunk.seq}: ${innerErr}${c.reset}`);
        }
        bytesProcessed += chunk.bytes;
      }
    }

    const percent = (bytesProcessed / totalBytes) * 100;
    progress.set(percent);

    const elapsed = (Date.now() - startTime) / 1000;
    const bytesPerSec = bytesProcessed / elapsed;
    const remainingBytes = totalBytes - bytesProcessed;
    const etaSec = remainingBytes / bytesPerSec;

    const bar = renderProgressBar(percent);
    const percentStr = percent.toFixed(0).padStart(3);
    const throughput = `${formatBytes(bytesPerSec)}/s`;
    const eta = etaSec > 0 && isFinite(etaSec) ? ` · ETA ${Math.ceil(etaSec)}s` : '';
    process.stderr.write(`\r${bar} ${percentStr}% · ${chunksEmbedded}/${totalChunks} chunks · ${throughput}${eta}  `);
  }

  progress.clear();
  cursor.show();
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n${c.green}✓ Embedded ${chunksEmbedded}/${totalChunks} chunks in ${totalTime}s${c.reset}`);
  if (errors > 0) {
    console.log(`${c.yellow}  ${errors} errors${c.reset}`);
  }

  closeDb();
}

// Sanitize a term for FTS5: remove punctuation except apostrophes
function sanitizeFTS5Term(term: string): string {
  // Remove all non-alphanumeric except apostrophes (for contractions like "don't")
  return term.replace(/[^\w']/g, '').trim();
}

// Build FTS5 query: phrase-aware with fallback to individual terms
function buildFTS5Query(query: string): string {
  // Sanitize the full query for phrase matching
  const sanitizedQuery = query.replace(/[^\w\s']/g, '').trim();

  const terms = query
    .split(/\s+/)
    .map(sanitizeFTS5Term)
    .filter(term => term.length >= 2); // Skip single chars and empty

  if (terms.length === 0) return "";
  if (terms.length === 1) return `"${terms[0]!.replace(/"/g, '""')}"`;

  // Strategy: exact phrase OR proximity match OR individual terms
  // Exact phrase matches rank highest, then close proximity, then any term
  const phrase = `"${sanitizedQuery.replace(/"/g, '""')}"`;
  const quotedTerms = terms.map(t => `"${t.replace(/"/g, '""')}"`);

  // FTS5 NEAR syntax: NEAR(term1 term2, distance)
  const nearPhrase = `NEAR(${quotedTerms.join(' ')}, 10)`;
  const orTerms = quotedTerms.join(' OR ');

  // Exact phrase > proximity > any term
  return `(${phrase}) OR (${nearPhrase}) OR (${orTerms})`;
}

// Normalize BM25 score to 0-1 range using sigmoid
function normalizeBM25(score: number): number {
  // BM25 scores are negative in SQLite (lower = better)
  // Typical range: -15 (excellent) to -2 (weak match)
  // Map to 0-1 where higher is better
  const absScore = Math.abs(score);
  // Sigmoid-ish normalization: maps ~2-15 range to ~0.1-0.95
  return 1 / (1 + Math.exp(-(absScore - 5) / 3));
}

function normalizeScores(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;
  const maxScore = Math.max(...results.map(r => r.score));
  const minScore = Math.min(...results.map(r => r.score));
  const range = maxScore - minScore || 1;
  return results.map(r => ({ ...r, score: (r.score - minScore) / range }));
}

// Reciprocal Rank Fusion: combines multiple ranked lists
// RRF score = sum(1 / (k + rank)) across all lists where doc appears
// k=60 is standard, provides good balance between top and lower ranks

function reciprocalRankFusion(
  resultLists: RankedResult[][],
  weights: number[] = [],  // Weight per result list (default 1.0)
  k: number = 60
): RankedResult[] {
  const scores = new Map<string, { score: number; displayPath: string; title: string; body: string; bestRank: number }>();

  for (let listIdx = 0; listIdx < resultLists.length; listIdx++) {
    const results = resultLists[listIdx];
    if (!results) continue;
    const weight = weights[listIdx] ?? 1.0;
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank];
      if (!doc) continue; // Ensure doc is not undefined
      const rrfScore = weight / (k + rank + 1);
      const existing = scores.get(doc.file);
      if (existing) {
        existing.score += rrfScore;
        if (rank < existing.bestRank) {
          // Update body to the chunk with best individual rank
          existing.bestRank = rank;
          existing.body = doc.body;
          existing.displayPath = doc.displayPath;
          existing.title = doc.title;
        }
      } else {
        scores.set(doc.file, { score: rrfScore, displayPath: doc.displayPath, title: doc.title, body: doc.body, bestRank: rank });
      }
    }
  }

  // Add bonus for best rank: documents that ranked #1-3 in any list get a boost
  // This prevents dilution of exact matches by expansion queries
  return Array.from(scores.entries())
    .map(([file, { score, displayPath, title, body, bestRank }]) => {
      let bonus = 0;
      if (bestRank === 0) bonus = 0.05;  // Ranked #1 somewhere
      else if (bestRank <= 2) bonus = 0.02;  // Ranked top-3 somewhere
      return { file, displayPath, title, body, score: score + bonus };
    })
    .sort((a, b) => b.score - a.score);
}

type OutputOptions = {
  format: OutputFormat;
  full: boolean;
  limit: number;
  minScore: number;
  all?: boolean;
  collection?: string[];  // Filter by collection name(s)
  lineNumbers?: boolean; // Add line numbers to output
  context?: string;      // Optional context for query expansion
  profile?: boolean;     // Show per-step timing breakdown
  verbose?: boolean;     // Show detailed debug output (chunk selection, reranker scores, etc.)
};

// Validate -c collection names: skip missing ones with a warning instead of hard exit.
// Returns the list of valid collection names, or undefined if none specified / all invalid.
function resolveCollectionFilter(opts: OutputOptions): string[] | undefined {
  if (!opts.collection || opts.collection.length === 0) return undefined;
  const valid: string[] = [];
  for (const name of opts.collection) {
    const coll = getCollectionFromYaml(name);
    if (coll) {
      valid.push(name);
    } else {
      process.stderr.write(`Warning: collection '${name}' not found, skipping\n`);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

// Highlight query terms in text (skip short words < 3 chars)
function highlightTerms(text: string, query: string): string {
  if (!useColor) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  let result = text;
  for (const term of terms) {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `${c.yellow}${c.bold}$1${c.reset}`);
  }
  return result;
}

// Format score with color based on value
function formatScore(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (!useColor) return `${pct}%`;
  if (score >= 0.7) return `${c.green}${pct}%${c.reset}`;
  if (score >= 0.4) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.dim}${pct}%${c.reset}`;
}

// Shorten directory path for display - relative to $HOME (used for context paths, not documents)
function shortPath(dirpath: string): string {
  const home = homedir();
  if (dirpath.startsWith(home)) {
    return '~' + dirpath.slice(home.length);
  }
  return dirpath;
}

// Add line numbers to text content
function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

function outputResults(results: { file: string; displayPath: string; title: string; body: string; score: number; context?: string | null; chunkPos?: number; hash?: string; docid?: string }[], query: string, opts: OutputOptions): void {
  // Filter by score, deduplicate by content hash (docid), then apply limit
  const aboveScore = results.filter(r => r.score >= opts.minScore);
  const seenDocids = new Set<string>();
  const deduped: typeof aboveScore = [];
  for (const r of aboveScore) {
    const key = r.docid || r.hash || r.displayPath;
    if (seenDocids.has(key)) continue;
    seenDocids.add(key);
    deduped.push(r);
  }

  // Content-level dedup: merge results with ≥90% text similarity
  // Jaccard similarity on character bigrams — fast, no LLM needed
  function bigramSet(text: string): Set<string> {
    const s = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) s.add(text.slice(i, i + 2));
    return s;
  }
  function textSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const sa = bigramSet(a), sb = bigramSet(b);
    let intersection = 0;
    for (const bg of sa) if (sb.has(bg)) intersection++;
    const union = sa.size + sb.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  const DEDUP_THRESHOLD = 0.9; // ≥90% similar → merge
  const contentDeduped: (typeof deduped[0] & { alsoIn?: string[] })[] = [];
  const normBodies: string[] = []; // parallel array of normalized bodies for comparison
  for (const r of deduped) {
    const normBody = (r.body || "").trim().replace(/\s+/g, " ");
    if (normBody.length < 10) {
      contentDeduped.push(r);
      normBodies.push("");
      continue;
    }
    // Check against all existing entries for similarity
    let mergedIdx = -1;
    for (let i = 0; i < normBodies.length; i++) {
      const existingNormBody = normBodies[i];
      if (!existingNormBody || existingNormBody.length < 10) continue;
      if (textSimilarity(normBody, existingNormBody) >= DEDUP_THRESHOLD) {
        mergedIdx = i;
        break;
      }
    }
    if (mergedIdx >= 0) {
      // Similar content already seen — record the duplicate source
      const existing = contentDeduped[mergedIdx] as typeof r & { alsoIn?: string[] };
      if (!existing.alsoIn) existing.alsoIn = [];
      existing.alsoIn.push(r.displayPath);
      // Keep the higher score
      if (r.score > existing.score) existing.score = r.score;
    } else {
      normBodies.push(normBody);
      contentDeduped.push(r);
    }
  }

  const filtered = contentDeduped.slice(0, opts.limit);

  if (filtered.length === 0) {
    console.log("No results found above minimum score threshold.");
    return;
  }

  // Helper to create qmd:// URI from displayPath
  const toQmdPath = (displayPath: string) => `qmd://${displayPath}`;

  if (opts.format === "json") {
    // JSON output for LLM consumption — always include full chunk body
    const output = filtered.map(row => {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let body = row.body;
      const { line, snippet: snippetText } = extractSnippet(row.body, query, 300, row.chunkPos);
      if (opts.lineNumbers && body) {
        body = addLineNumbers(body);
      }
      return {
        ...(docid && { docid: `#${docid}` }),
        score: Math.round(row.score * 100) / 100,
        file: toQmdPath(row.displayPath),
        title: row.title,
        ...(row.context && { context: row.context }),
        ...((row as any).alsoIn?.length && { alsoIn: (row as any).alsoIn.map(toQmdPath) }),
        body,
        snippet: body || snippetText,  // Use body as snippet so OpenClaw gets the full content
      };
    });
    // Use process.stdout.write directly to bypass console.log→stderr redirect in JSON mode
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else if (opts.format === "files") {
    // Simple docid,score,filepath,context output
    for (const row of filtered) {
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const ctx = row.context ? `,"${row.context.replace(/"/g, '""')}"` : "";
      console.log(`#${docid},${row.score.toFixed(2)},${toQmdPath(row.displayPath)}${ctx}`);
    }
  } else if (opts.format === "cli") {
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos);
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);

      // Line 1: filepath with docid
      const path = toQmdPath(row.displayPath);
      // Only show :line if we actually found a term match in the snippet body (exclude header line).
      const snippetBody = snippet.split("\n").slice(1).join("\n").toLowerCase();
      const hasMatch = query.toLowerCase().split(/\s+/).some(t => t.length > 0 && snippetBody.includes(t));
      const lineInfo = hasMatch ? `:${line}` : "";
      const docidStr = docid ? ` ${c.dim}#${docid}${c.reset}` : "";
      console.log(`${c.cyan}${path}${c.dim}${lineInfo}${c.reset}${docidStr}`);

      // Line 2: Title (if available)
      if (row.title) {
        console.log(`${c.bold}Title: ${row.title}${c.reset}`);
      }

      // Line 3: Context (if available)
      if (row.context) {
        console.log(`${c.dim}Context: ${row.context}${c.reset}`);
      }

      // Line 4: Score
      const score = formatScore(row.score);
      console.log(`Score: ${c.bold}${score}${c.reset}`);
      console.log();

      // Snippet with highlighting (diff-style header included)
      let displaySnippet = opts.lineNumbers ? addLineNumbers(snippet, line) : snippet;
      const highlighted = highlightTerms(displaySnippet, query);
      console.log(highlighted);

      // Double empty line between results
      if (i < filtered.length - 1) console.log('\n');
    }
  } else if (opts.format === "md") {
    for (let i = 0; i < filtered.length; i++) {
      const row = filtered[i];
      if (!row) continue;
      const heading = row.title || row.displayPath;
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : undefined);
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      const docidLine = docid ? `**docid:** \`#${docid}\`\n` : "";
      const contextLine = row.context ? `**context:** ${row.context}\n` : "";
      console.log(`---\n# ${heading}\n${docidLine}${contextLine}\n${content}\n`);
    }
  } else if (opts.format === "xml") {
    for (const row of filtered) {
      const titleAttr = row.title ? ` title="${row.title.replace(/"/g, '&quot;')}"` : "";
      const contextAttr = row.context ? ` context="${row.context.replace(/"/g, '&quot;')}"` : "";
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      let content = opts.full ? row.body : extractSnippet(row.body, query, 500, row.chunkPos).snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content);
      }
      console.log(`<file docid="#${docid}" name="${toQmdPath(row.displayPath)}"${titleAttr}${contextAttr}>\n${content}\n</file>\n`);
    }
  } else {
    // CSV format
    console.log("docid,score,file,title,context,line,snippet");
    for (const row of filtered) {
      const { line, snippet } = extractSnippet(row.body, query, 500, row.chunkPos);
      let content = opts.full ? row.body : snippet;
      if (opts.lineNumbers) {
        content = addLineNumbers(content, line);
      }
      const docid = row.docid || (row.hash ? row.hash.slice(0, 6) : "");
      const snippetText = content || "";
      console.log(`#${docid},${row.score.toFixed(4)},${escapeCSV(toQmdPath(row.displayPath))},${escapeCSV(row.title || "")},${escapeCSV(row.context || "")},${line},${escapeCSV(snippetText)}`);
    }
  }
}

function search(query: string, opts: OutputOptions): void {
  const db = getDb();

  // Validate collection filter if specified
  const collectionNames = resolveCollectionFilter(opts);

  // Use large limit for --all, otherwise fetch more than needed and let outputResults filter
  const fetchLimit = opts.all ? 100000 : Math.max(50, opts.limit * 2);
  const results = searchFTS(db, query, fetchLimit, collectionNames);

  // Add context to results
  const resultsWithContext = results.map(r => ({
    file: r.filepath,
    displayPath: r.displayPath,
    title: r.title,
    body: r.body || "",
    score: r.score,
    context: getContextForFile(db, r.filepath),
    hash: r.hash,
    docid: r.docid,
  }));

  closeDb();

  if (resultsWithContext.length === 0) {
    console.log("No results found.");
    return;
  }
  outputResults(resultsWithContext, query, opts);
}

async function vectorSearch(query: string, opts: OutputOptions, model: string = DEFAULT_EMBED_MODEL): Promise<void> {
  const db = getDb();

  // Validate collection filter if specified
  const collectionNames = resolveCollectionFilter(opts);

  const vecTableExists = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  const hasVectorRuntime = isVectorRuntimeAvailable(db);
  if (!hasVectorRuntime) {
    if (vecTableExists && process.env.QMD_ALLOW_SQLITE_EXTENSIONS !== "1") {
      console.error(
        "Vector index exists, but SQLite extensions are disabled. " +
        "Set QMD_ALLOW_SQLITE_EXTENSIONS=1 to enable sqlite-vec and use vector search."
      );
    } else {
      console.error("Vector index not found. Run 'qmd embed' first to create embeddings.");
    }
    closeDb();
    return;
  }

  // Check index health and warn about issues
  checkIndexHealth(db);

  // Shared query logic (works with either remote or local session)
  const runQuery = async (expandFn: (q: string, opts?: any) => Promise<Queryable[]>) => {
    // Expand query using structured output (no lexical for vector-only search)
    const queryables = await expandFn(query, { includeLexical: false, context: opts.context });

    // Build list of queries for vector search: original, vec, and hyde
    const vectorQueries: string[] = [query];
    for (const q of queryables) {
      if (q.type === 'vec' || q.type === 'hyde') {
        if (q.text && q.text !== query) {
          vectorQueries.push(q.text);
        }
      }
    }

    if (!_quietMode) process.stderr.write(`${c.dim}Searching ${vectorQueries.length} vector queries...${c.reset}\n`);

    // Collect results from all query variations
    const perQueryLimit = opts.all ? 500 : 20;
    const allResults = new Map<string, { file: string; displayPath: string; title: string; body: string; score: number; hash: string }>();

    for (const q of vectorQueries) {
      const vecResults = await searchVec(db, q, model, perQueryLimit, collectionNames, undefined);
      for (const r of vecResults) {
        const existing = allResults.get(r.filepath);
        if (!existing || r.score > existing.score) {
          allResults.set(r.filepath, { file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score, hash: r.hash });
        }
      }
    }

    // Sort by max score and limit to requested count
    const results = Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
      .map(r => ({ ...r, context: getContextForFile(db, r.file) }));

    closeDb();

    if (results.length === 0) {
      console.log("No results found.");
      return;
    }
    outputResults(results, query, { ...opts, limit: results.length });
  };

  await llmService.withSession(async (session) => {
    const expandFn = (q: string, expandOpts?: any) =>
      expandQueryStructured(q, expandOpts?.includeLexical ?? false, expandOpts?.context, session);
    await runQuery(expandFn);
  }, { maxDuration: 10 * 60 * 1000, name: 'vectorSearch' });
}

// Expand query using structured output with GBNF grammar
async function expandQueryStructured(query: string, includeLexical: boolean = true, context?: string, session?: ILLMSession, quiet?: boolean): Promise<Queryable[]> {
  if (!quiet) process.stderr.write(`${c.dim}Expanding query...${c.reset}\n`);
  const queryables = await llmService.expandQuery(query, { includeLexical, context }, session);

  // Log the expansion as a tree
  if (!quiet) {
    const lines: string[] = [];
    const bothLabel = includeLexical ? ' · (lexical+vector)' : ' · (vector)';
    lines.push(`${c.dim}├─ ${query}${bothLabel}${c.reset}`);

    for (let i = 0; i < queryables.length; i++) {
      const q = queryables[i];
      if (!q || q.text === query) continue;

      let textPreview = q.text.replace(/\n/g, ' ');
      if (textPreview.length > 80) {
        textPreview = textPreview.substring(0, 77) + '...';
      }

      const label = q.type === 'lex' ? 'lexical' : (q.type === 'hyde' ? 'hyde' : 'vector');
      lines.push(`${c.dim}├─ ${textPreview} · (${label})${c.reset}`);
    }

    // Fix last item to use └─ instead of ├─
    if (lines.length > 0) {
      lines[lines.length - 1] = lines[lines.length - 1]!.replace('├─', '└─');
    }

    for (const line of lines) {
      process.stderr.write(line + '\n');
    }
  }

  return queryables;
}

async function expandQuery(query: string, _model: string = DEFAULT_QUERY_MODEL, _db?: Database, session?: ILLMSession): Promise<string[]> {
  const queryables = await expandQueryStructured(query, true, undefined, session);
  const queries = new Set<string>([query]);
  for (const q of queryables) {
    queries.add(q.text);
  }
  return Array.from(queries);
}

async function querySearch(query: string, opts: OutputOptions, embedModel: string = DEFAULT_EMBED_MODEL, rerankModel: string = DEFAULT_RERANK_MODEL): Promise<void> {
  // When outputting JSON, redirect debug console.log to stderr so stdout is pure JSON
  const origLog = console.log;
  if (opts.format === "json") {
    console.log = (...args: any[]) => console.error(...args);
  }
  try {
    await _querySearchImpl(query, opts, embedModel, rerankModel);
  } finally {
    console.log = origLog;
  }
}

async function _querySearchImpl(query: string, opts: OutputOptions, embedModel: string, rerankModel: string): Promise<void> {
  if (opts.verbose || opts.profile) console.log(`\n=== querySearch START: query="${query}" ===\n`);
  const db = getDb();
  const _profile = opts.profile;
  const _verbose = opts.verbose || opts.profile;
  const prevQuietMode = _quietMode;
  _quietMode = !_verbose;
  const _timings: { step: string; ms: number; detail?: string }[] = [];
  const _t0 = Date.now();
  let _tStep = _t0;

  // Validate collection filter if specified
  const collectionNames = resolveCollectionFilter(opts);

  // Check index health and warn about issues
  checkIndexHealth(db);

  // Run initial BM25 search (will be reused for retrieval)
  const initialFts = searchFTS(db, query, 20, collectionNames);
  let hasVectors = isVectorRuntimeAvailable(db);
  if (_profile) { _timings.push({ step: "初始FTS", ms: Date.now() - _tStep, detail: `${initialFts.length} results` }); _tStep = Date.now(); }

  // Check if initial results have strong signals (skip expansion if so)
  // Strong signal = top result is strong AND clearly separated from runner-up.
  // This avoids skipping expansion when BM25 has lots of mediocre matches.
  const topScore = initialFts[0]?.score ?? 0;
  const secondScore = initialFts[1]?.score ?? 0;
  const hasStrongSignal = initialFts.length > 0 && topScore >= 0.85 && (topScore - secondScore) >= 0.15;

  // Core query logic - extracted so it can run with or without session
  const runQuerySearch = async (session?: ILLMSession) => {
    let ftsQueries: string[] = [query];
    let vectorQueries: string[] = [query];

    if (hasStrongSignal) {
      // Strong BM25 signal - skip expensive LLM expansion
      if (_verbose) {
        process.stderr.write(`${c.dim}Strong BM25 signal (${topScore.toFixed(2)}) - skipping expansion${c.reset}\n`);
        const lines: string[] = [];
        lines.push(`${c.dim}├─ ${query} · (lexical+vector)${c.reset}`);
        lines[lines.length - 1] = lines[lines.length - 1]!.replace('├─', '└─');
        for (const line of lines) process.stderr.write(line + '\n');
      }
      if (_profile) { _timings.push({ step: "查询扩展", ms: Date.now() - _tStep, detail: "跳过(强BM25信号)" }); _tStep = Date.now(); }
    } else {
      // Weak signal - expand query for better recall
      const queryables = await expandQueryStructured(query, true, opts.context, session, !_verbose);

      for (const q of queryables) {
        if (q.type === 'lex') {
          if (q.text && q.text !== query) ftsQueries.push(q.text);
        } else if (q.type === 'vec' || q.type === 'hyde') {
          if (q.text && q.text !== query) vectorQueries.push(q.text);
        }
      }
      if (_profile) { _timings.push({ step: "查询扩展", ms: Date.now() - _tStep, detail: `${ftsQueries.length}词法 + ${vectorQueries.length}向量` }); _tStep = Date.now(); }
    }

    if (_verbose) process.stderr.write(`${c.dim}Searching ${ftsQueries.length} lexical + ${vectorQueries.length} vector queries...${c.reset}\n`);

    // Collect ranked result lists for RRF fusion
    const rankedLists: RankedResult[][] = [];

    // Map to store hash by filepath for final results
    const hashMap = new Map<string, string>();

    // Run all searches concurrently (FTS + Vector)
    const searchPromises: Promise<void>[] = [];

    // FTS searches
    for (const q of ftsQueries) {
      if (!q) continue;
      searchPromises.push((async () => {
        const ftsResults = searchFTS(db, q, 20, collectionNames);
        if (ftsResults.length > 0) {
          for (const r of ftsResults) {
            // Mutex for hashMap is not strictly needed as it's just adding values
            hashMap.set(r.filepath, r.hash);
          }
          rankedLists.push(ftsResults.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
        }
      })());
    }

    // Vector searches (session ensures contexts stay alive)
    if (hasVectors) {
      for (const q of vectorQueries) {
        if (!q) continue;
        searchPromises.push((async () => {
          const vecResults = await searchVec(db, q, embedModel, 20, collectionNames, session);
          if (vecResults.length > 0) {
            for (const r of vecResults) hashMap.set(r.filepath, r.hash);
            rankedLists.push(vecResults.map(r => ({ file: r.filepath, displayPath: r.displayPath, title: r.title, body: r.body || "", score: r.score })));
          }
        })());
      }
    }

    await Promise.all(searchPromises);
    if (_profile) { _timings.push({ step: "检索", ms: Date.now() - _tStep, detail: `${rankedLists.length}组结果` }); _tStep = Date.now(); }

    // Apply Reciprocal Rank Fusion to combine all ranked lists
    // Give 2x weight to original query results (first 2 lists: FTS + vector)
    const weights = rankedLists.map((_, i) => i < 2 ? 2.0 : 1.0);
    const fused = reciprocalRankFusion(rankedLists, weights);
    // Hard cap reranking for latency/cost. We rerank per-document (best chunk only).
    const RERANK_DOC_LIMIT = parseInt(process.env.QMD_RERANK_DOC_LIMIT || "40", 10);
    const candidates = fused.slice(0, RERANK_DOC_LIMIT);

    if (candidates.length === 0) {
      console.log("No results found.");
      closeDb();
      return;
    }

    // Rerank multiple chunks per document, then aggregate scores.
    // Avoid top-1 chunk truncation by sending top-N chunks per doc to reranker.
    const PER_DOC_CHUNK_LIMIT = parseInt(process.env.QMD_RERANK_CHUNKS_PER_DOC || "3", 10);
    const chunksToRerank: { key: string; file: string; text: string; chunkIdx: number }[] = [];
    const docChunkMap = new Map<string, { chunks: { text: string; pos: number }[] }>();
    const chunkMetaByKey = new Map<string, { file: string; chunkIdx: number }>();

    // CJK-aware term extraction: prioritize complete query + trigrams
    const extractTerms = (text: string): string[] => {
      const terms: string[] = [];
      const lowerText = text.toLowerCase();
      
      // Add complete query as highest-priority term (for exact/substring matches)
      terms.push(lowerText);
      
      // Split by whitespace and extract n-grams
      for (const word of lowerText.split(/\s+/)) {
        // Check if word contains CJK characters
        const cjkRanges = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
        if (cjkRanges.test(word)) {
          // Extract CJK chars for substring matching
          const chars = [...word].filter(c => cjkRanges.test(c));
          // Trigrams (most specific, high priority)
          for (let i = 0; i <= chars.length - 3; i++) {
            terms.push(chars[i]! + chars[i + 1]! + chars[i + 2]!);
          }
          // For short CJK (1-2 chars), add as-is (fallback for queries like "主人")
          if (chars.length < 3) {
            terms.push(chars.join(''));
          }
        } else if (word.length > 2) {
          terms.push(word);
        }
      }
      return [...new Set(terms)];
    };
    const queryTerms = extractTerms(query);
    if (_verbose) {
      console.log("\n=== QUERY TERMS ===");
      console.log(`  ${queryTerms.join(', ')}`);
      console.log("");
    }
    
    for (const cand of candidates) {
      const chunks = chunkDocument(cand.body);
      if (chunks.length === 0) continue;

      // Rank chunks by keyword match score (higher is better)
      const chunkScores: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkLower = chunks[i]!.text.toLowerCase();
        const score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
        chunkScores.push(score);
      }

      const sortedChunkIndexes = chunkScores
        .map((score, idx) => ({ score, idx }))
        .sort((a, b) => b.score - a.score)
        .map(item => item.idx);
      const selectedChunkIndexes = sortedChunkIndexes.slice(0, Math.min(PER_DOC_CHUNK_LIMIT, chunks.length));

      // DEBUG: Log chunk selection for MEMORY.md
      if (_verbose && cand.file.includes('memory.md') && chunks.length > 1) {
        console.log(`\n=== CHUNK SELECTION: ${cand.file} ===`);
        for (let i = 0; i < chunks.length; i++) {
          const preview = chunks[i]!.text.substring(0, 80).replace(/\n/g, ' ');
          console.log(`  chunk ${i}: score=${chunkScores[i]} preview: ${preview}...`);
        }
        const selectedPreview = selectedChunkIndexes
          .map(idx => `#${idx}(score=${chunkScores[idx]})`)
          .join(', ');
        console.log(`  → Selected chunks: ${selectedPreview}`);
        console.log("");
      }

      for (const chunkIdx of selectedChunkIndexes) {
        const key = `${cand.file}::${chunkIdx}`;
        chunksToRerank.push({ key, file: cand.file, text: chunks[chunkIdx]!.text, chunkIdx });
        chunkMetaByKey.set(key, { file: cand.file, chunkIdx });
      }
      docChunkMap.set(cand.file, { chunks });
    }
    if (_profile) { _timings.push({ step: "融合+分块", ms: Date.now() - _tStep, detail: `${candidates.length}文档→${chunksToRerank.length}块` }); _tStep = Date.now(); }

    // DEBUG: Log selected chunks for reranking
    if (_verbose) {
      console.log("\n=== CHUNKS SENT TO RERANKER ===");
      for (let i = 0; i < Math.min(6, chunksToRerank.length); i++) {
        const ch = chunksToRerank[i]!;
        const fname = ch.file.split('/').pop();
        const preview = ch.text.substring(0, 100).replace(/\n/g, ' ');
        console.log(`  ${i+1}. ${fname} chunk#${ch.chunkIdx}: ${preview}...`);
      }
      console.log("");
    }

    // Rerank selected chunks (with caching).
    const reranked = await rerank(
      query,
      chunksToRerank.map(ch => ({ file: ch.key, text: ch.text })),
      rerankModel,
      db,
      session
    );
    if (_profile) { _timings.push({ step: "重排", ms: Date.now() - _tStep, detail: `${chunksToRerank.length}块 via ${process.env.QMD_RERANK_PROVIDER || 'local'}` }); _tStep = Date.now(); }

    // DEBUG: Log reranker scores
    if (_verbose) {
      console.log("\n=== RERANKER SCORES ===");
      for (let i = 0; i < Math.min(6, reranked.length); i++) {
        const r = reranked[i]!;
        console.log(`  ${i+1}. score=${r.score.toFixed(4)} ${r.file.split('/').pop()}`);
      }
      console.log("");
    }

    // Check if LLM rerank returned extracts (indicates LLM extraction mode)
    const hasExtracts = reranked.some(r => r.extract);

    const aggregatedScores = new Map<string, { score: number; bestChunkIdx: number; extract?: string }>();
    for (const r of reranked) {
      const meta = chunkMetaByKey.get(r.file);
      if (!meta) continue;
      const existing = aggregatedScores.get(meta.file);
      // Keep the highest reranker score across all chunks of the same document
      if (!existing || r.score > existing.score) {
        aggregatedScores.set(meta.file, { score: r.score, bestChunkIdx: meta.chunkIdx, extract: r.extract });
      }
    }

    // Blend RRF position score with aggregated reranker score using position-aware weights
    // Top retrieval results get more protection from reranker disagreement
    const candidateMap = new Map(candidates.map(cand => [cand.file, { displayPath: cand.displayPath, title: cand.title, body: cand.body }]));
    const rrfRankMap = new Map(candidates.map((cand, i) => [cand.file, i + 1])); // 1-indexed rank

    const finalResults = Array.from(aggregatedScores.entries()).map(([file, { score: rerankScore, bestChunkIdx, extract }]) => {
      const candidate = candidateMap.get(file);
      const chunkInfo = docChunkMap.get(file);

      let finalScore: number;
      let finalBody: string;

      if (hasExtracts) {
        // LLM extraction mode: trust LLM's ordering directly, use extract as body
        finalScore = rerankScore;
        finalBody = extract || (chunkInfo ? (chunkInfo.chunks[bestChunkIdx]?.text || chunkInfo.chunks[0]!.text) : candidate?.body || "");
      } else {
        // Traditional reranker mode: blend RRF + reranker scores
        const rrfRank = rrfRankMap.get(file) || 30;
        let rrfWeight: number;
        if (rrfRank <= 3) {
          rrfWeight = 0.75;
        } else if (rrfRank <= 10) {
          rrfWeight = 0.60;
        } else {
          rrfWeight = 0.40;
        }
        const rrfScore = 1 / rrfRank;
        finalScore = rrfWeight * rrfScore + (1 - rrfWeight) * rerankScore;
        finalBody = chunkInfo ? (chunkInfo.chunks[bestChunkIdx]?.text || chunkInfo.chunks[0]!.text) : candidate?.body || "";
      }

      const chunkPos = chunkInfo ? (chunkInfo.chunks[bestChunkIdx]?.pos || 0) : 0;
      return {
        file,
        displayPath: candidate?.displayPath || "",
        title: candidate?.title || "",
        body: finalBody,
        chunkPos,
        score: finalScore,
        context: getContextForFile(db, file),
        hash: hashMap.get(file) || "",
      };
    });

    // DEBUG: before sort
    if (_verbose) {
      console.log("\n=== BEFORE SORT ===");
      for (let i = 0; i < Math.min(3, finalResults.length); i++) {
        console.log(`  ${i}: score=${finalResults[i]!.score.toFixed(4)} ${finalResults[i]!.displayPath}`);
      }
    }

    finalResults.sort((a, b) => b.score - a.score);

    // DEBUG: after sort
    if (_verbose) {
      console.log("\n=== AFTER SORT ===");
      for (let i = 0; i < Math.min(6, finalResults.length); i++) {
        console.log(`  ${i}: score=${finalResults[i]!.score.toFixed(4)} ${finalResults[i]!.displayPath}`);
      }
      console.log("");
    }

    // File-level dedup DISABLED — allow multiple chunks from same file to surface
    // const seenFiles = new Set<string>();
    // const dedupedResults = finalResults.filter(r => {
    //   if (seenFiles.has(r.file)) return false;
    //   seenFiles.add(r.file);
    //   return true;
    // });

    if (_profile) {
      _timings.push({ step: "排序", ms: Date.now() - _tStep, detail: `${finalResults.length}条结果` });
      const totalMs = Date.now() - _t0;
      process.stderr.write(`\n${c.dim}步骤\tms\t占比\t详情${c.reset}\n`);
      for (const t of _timings) {
        const pct = Math.round(t.ms / totalMs * 100);
        process.stderr.write(`${t.step}\t${t.ms}\t${pct}%\t${t.detail || ""}\n`);
      }
      process.stderr.write(`${c.bold}合计\t${totalMs}\t100%${c.reset}\n`);
    }

    closeDb();
    outputResults(finalResults, query, opts);
  };

  try {
  await llmService.withSession(async (session) => {
    await runQuerySearch(session);
  }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
  } finally {
    _quietMode = prevQuietMode;
  }
}

// Parse CLI arguments using util.parseArgs
function parseCLI() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2), // Skip bun and script path
    options: {
      // Global options
      index: {
        type: "string",
      },
      context: {
        type: "string",
      },
      "no-lex": {
        type: "boolean",
      },
      help: { type: "boolean", short: "h" },
      // Search options
      n: { type: "string" },
      "min-score": { type: "string" },
      all: { type: "boolean" },
      full: { type: "boolean" },
      csv: { type: "boolean" },
      md: { type: "boolean" },
      xml: { type: "boolean" },
      files: { type: "boolean" },
      json: { type: "boolean" },
      collection: { type: "string", short: "c", multiple: true },  // Filter by collection(s)
      // Collection options
      name: { type: "string" },  // collection name
      mask: { type: "string" },  // glob pattern
      // Embed options
      force: { type: "boolean", short: "f" },
      timeout: { type: "string" }, // embed/query remote timeout override
      // Update options
      pull: { type: "boolean" },  // git pull before update
      "allow-run": { type: "boolean" },
      refresh: { type: "boolean" },
      // Get options
      l: { type: "string" },  // max lines
      from: { type: "string" },  // start line
      "max-bytes": { type: "string" },  // max bytes for multi-get
      "line-numbers": { type: "boolean" },  // add line numbers to output
      // Doctor options
      bench: { type: "boolean" },  // enable quality benchmark in doctor
      // Profile options
      profile: { type: "boolean" },  // show per-step timing breakdown
      verbose: { type: "boolean", short: "v" },  // show detailed debug output
    },
    allowPositionals: true,
    strict: false, // Allow unknown options to pass through
  });

  // Select index name (default: "index")
  const indexName = values.index as string | undefined;
  if (indexName) {
    setIndexName(indexName);
    setConfigIndexName(indexName);
  }

  // Determine output format
  let format: OutputFormat = "cli";
  if (values.csv) format = "csv";
  else if (values.md) format = "md";
  else if (values.xml) format = "xml";
  else if (values.files) format = "files";
  else if (values.json) format = "json";

  // Default limit: 20 for --files/--json, 5 otherwise
  // --all means return all results (use very large limit)
  const defaultLimit = (format === "files" || format === "json") ? 20 : 5;
  const isAll = !!values.all;

  const opts: OutputOptions = {
    format,
    full: !!values.full,
    limit: isAll ? 100000 : (values.n ? parseInt(String(values.n), 10) || defaultLimit : defaultLimit),
    minScore: values["min-score"] ? parseFloat(String(values["min-score"])) || 0 : 0,
    all: isAll,
    collection: values.collection as string[] | undefined,
    lineNumbers: !!values["line-numbers"],
    profile: !!values.profile,
    verbose: !!values.verbose,
  };

  return {
    command: positionals[0] || "",
    args: positionals.slice(1),
    query: positionals.slice(1).join(" "),
    opts,
    values,
  };
}

function parseTimeoutFlagToMs(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "").toLowerCase();
  if (unit === "ms") return Math.round(n);
  if (unit === "m") return Math.round(n * 60_000);
  if (unit === "s") return Math.round(n * 1_000);
  // No unit: heuristic (>=1000 => ms, else seconds)
  return n >= 1000 ? Math.round(n) : Math.round(n * 1_000);
}

function showHelp(): void {
  console.log("Usage:");
  console.log("  qmd collection add [path] --name <name> --mask <pattern>  - Create/index collection");
  console.log("  qmd collection list           - List all collections with details");
  console.log("  qmd collection remove <name>  - Remove a collection by name");
  console.log("  qmd collection rename <old> <new>  - Rename a collection");
  console.log("  qmd ls [collection[/path]]    - List collections or files in a collection");
  console.log("  qmd context add [path] \"text\" - Add context for path (defaults to current dir)");
  console.log("  qmd context list              - List all contexts");
  console.log("  qmd context rm <path>         - Remove context");
  console.log("  qmd get <file>[:line] [-l N] [--from N]  - Get document (optionally from line, max N lines)");
  console.log("  qmd multi-get <pattern> [-l N] [--max-bytes N]  - Get multiple docs by glob or comma-separated list");
  console.log("  qmd status                    - Show index status and collections");
  console.log("  qmd update [--pull] [--allow-run] - Re-index all collections (--allow-run: run collection update commands)");
  console.log("  qmd embed [-f] [--timeout N]  - Create vector embeddings (800 tokens/chunk, 15% overlap)");
  console.log("  qmd cleanup                   - Remove cache and orphaned data, vacuum DB");
  console.log("  qmd search <query>            - Full-text search (BM25)");
  console.log("  qmd vsearch <query>           - Vector similarity search");
  console.log("  qmd query <query> [--timeout N] - Combined search with query expansion + reranking");
  console.log("  qmd doctor                    - Diagnose runtime env, providers/models, and vector dimensions");
  console.log("  qmd mcp                       - Start MCP server (for AI agent integration)");
  console.log("");
  console.log("Note:");
  console.log("  Local model support has been removed. Configure a remote provider via API keys (QMD_SILICONFLOW_API_KEY / QMD_OPENAI_API_KEY / QMD_GEMINI_API_KEY / QMD_DASHSCOPE_API_KEY).");
  console.log("");
  console.log("Global options:");
  console.log("  --index <name>             - Use custom index name (default: index)");
  console.log("  --profile                  - Show per-step timing breakdown (query command)");
  console.log("  -v, --verbose              - Show detailed debug output (chunk selection, reranker scores)");
  console.log("");
  console.log("Search options:");
  console.log("  -n <num>                   - Number of results (default: 5, or 20 for --files)");
  console.log("  --all                      - Return all matches (use with --min-score to filter)");
  console.log("  --min-score <num>          - Minimum similarity score");
  console.log("  --full                     - Output full document instead of snippet");
  console.log("  --line-numbers             - Add line numbers to output");
  console.log("  --files                    - Output docid,score,filepath,context (default: 20 results)");
  console.log("  --json                     - JSON output with snippets (default: 20 results)");
  console.log("  --csv                      - CSV output with snippets");
  console.log("  --md                       - Markdown output");
  console.log("  --xml                      - XML output");
  console.log("  -c, --collection <name>    - Filter results to a specific collection");
  console.log("");
  console.log("Multi-get options:");
  console.log("  -l <num>                   - Maximum lines per file");
  console.log("  --max-bytes <num>          - Skip files larger than N bytes (default: 10240)");
  console.log("  --json/--csv/--md/--xml/--files - Output format (same as search)");
  console.log("");
  console.log(`Index: ${getDbPath()}`);
}

function cleanupCommand(): void {
  const db = getDb();

  const cacheCount = deleteLLMCache(db);
  console.log(`${c.green}✓${c.reset} Cleared ${cacheCount} cached API responses`);

  const orphanedVecs = cleanupOrphanedVectors(db);
  if (orphanedVecs > 0) {
    console.log(`${c.green}✓${c.reset} Removed ${orphanedVecs} orphaned embedding chunks`);
  } else {
    console.log(`${c.dim}No orphaned embeddings to remove${c.reset}`);
  }

  const inactiveDocs = deleteInactiveDocuments(db);
  if (inactiveDocs > 0) {
    console.log(`${c.green}✓${c.reset} Removed ${inactiveDocs} inactive document records`);
  }

  vacuumDatabase(db);
  console.log(`${c.green}✓${c.reset} Database vacuumed`);

  closeDb();
}

function maskValue(value?: string): string {
  if (!value) return "<unset>";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseLaunchdEnvironmentVariables(plistPath: string): Record<string, string> {
  try {
    const content = readFileSync(plistPath, "utf8");
    const blockMatch = content.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
    if (!blockMatch || !blockMatch[1]) return {};
    const block = blockMatch[1];
    const env: Record<string, string> = {};
    const pairRegex = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
    let m: RegExpExecArray | null;
    while ((m = pairRegex.exec(block)) !== null) {
      const key = m[1]?.trim();
      const raw = m[2] || "";
      const value = raw
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (key) env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

async function doctorCommand(bench = false): Promise<void> {
  // Discover launchd plist: env override → OpenClaw default location
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const launchdPlist = process.env.QMD_LAUNCHD_PLIST
    || (homeDir ? `${homeDir}/Library/LaunchAgents/ai.openclaw.gateway.plist` : "");
  const launchdEnv = launchdPlist ? parseLaunchdEnvironmentVariables(launchdPlist) : {};

  const runtime = process.env;
  const isLaunchdProcess = !!runtime.OPENCLAW_LAUNCHD_LABEL || !!runtime.OPENCLAW_SERVICE_KIND;

  const sfKeyRuntime = runtime.QMD_SILICONFLOW_API_KEY;
  const gmKeyRuntime = runtime.QMD_GEMINI_API_KEY;
  const oaKeyRuntime = runtime.QMD_OPENAI_API_KEY;
  const dsKeyRuntime = runtime.QMD_DASHSCOPE_API_KEY;
  const rerankMode = (runtime.QMD_RERANK_MODE as "llm" | "rerank" | undefined) || "llm";
  const sfLlmRerankModel = runtime.QMD_SILICONFLOW_LLM_RERANK_MODEL || runtime.QMD_LLM_RERANK_MODEL || "zai-org/GLM-4.5-Air";

  const configuredRerankProvider = runtime.QMD_RERANK_PROVIDER as "siliconflow" | "gemini" | "openai" | "dashscope" | undefined;
  let rerankProvider: "siliconflow" | "gemini" | "openai" | "dashscope" | undefined;
  if (rerankMode === "rerank") {
    if (configuredRerankProvider === "dashscope" && dsKeyRuntime) {
      rerankProvider = "dashscope";
    } else if (sfKeyRuntime) {
      rerankProvider = "siliconflow";
    } else if (configuredRerankProvider === "gemini" && gmKeyRuntime) {
      rerankProvider = "gemini";
    } else if (configuredRerankProvider === "openai" && oaKeyRuntime) {
      rerankProvider = "openai";
    } else if (dsKeyRuntime) {
      rerankProvider = "dashscope";
    } else {
      rerankProvider = gmKeyRuntime ? "gemini" : (oaKeyRuntime ? "openai" : undefined);
    }
  } else {
    if (configuredRerankProvider === "dashscope" && dsKeyRuntime) {
      rerankProvider = "dashscope";
    } else if (configuredRerankProvider === "gemini" || configuredRerankProvider === "openai") {
      rerankProvider = configuredRerankProvider;
    } else if (configuredRerankProvider === "siliconflow") {
      rerankProvider = sfKeyRuntime ? "openai" : undefined;
    } else {
      rerankProvider = sfKeyRuntime ? "openai" : (gmKeyRuntime ? "gemini" : (oaKeyRuntime ? "openai" : undefined));
    }
  }
  const embedProvider = (runtime.QMD_EMBED_PROVIDER as "siliconflow" | "openai" | undefined)
    || (sfKeyRuntime ? "siliconflow" : (oaKeyRuntime ? "openai" : undefined));
  const queryExpansionProvider = (runtime.QMD_QUERY_EXPANSION_PROVIDER as "siliconflow" | "gemini" | "openai" | undefined)
    || (sfKeyRuntime ? "siliconflow" : (oaKeyRuntime ? "openai" : (gmKeyRuntime ? "gemini" : undefined)));

  const effectiveEmbedModel = embedProvider === "openai"
    ? (runtime.QMD_OPENAI_EMBED_MODEL || "text-embedding-3-small")
    : (runtime.QMD_SILICONFLOW_EMBED_MODEL || "Qwen/Qwen3-Embedding-8B");
  const effectiveSfRerankModel = runtime.QMD_SILICONFLOW_RERANK_MODEL || runtime.QMD_SILICONFLOW_MODEL || "BAAI/bge-reranker-v2-m3";
  const effectiveGmModel = runtime.QMD_GEMINI_RERANK_MODEL || runtime.QMD_GEMINI_MODEL || "gemini-2.5-flash";
  const effectiveOaModel = runtime.QMD_OPENAI_MODEL || (sfKeyRuntime ? sfLlmRerankModel : "gpt-4o-mini");
  const effectiveDsRerankModel = runtime.QMD_DASHSCOPE_RERANK_MODEL || "qwen3-rerank";
  const effectiveQueryExpansionModel = queryExpansionProvider === "siliconflow"
    ? (runtime.QMD_SILICONFLOW_QUERY_EXPANSION_MODEL || "zai-org/GLM-4.5-Air")
    : (queryExpansionProvider === "openai" ? effectiveOaModel : effectiveGmModel);

  const db = getDb();
  const vecTableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  const vecDim = vecTableInfo?.sql.match(/float\[(\d+)\]/)?.[1] || null;

  let probeDim: number | null = null;
  let probeError: string | null = null;
  const canProbeRemoteEmbed = !!embedProvider && (!!sfKeyRuntime || !!oaKeyRuntime);
  if (canProbeRemoteEmbed) {
    try {
      const probe = await llmService.embed("qmd dimension probe", { model: effectiveEmbedModel, isQuery: true });
      probeDim = probe.embedding.length;
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
  }

  console.log("QMD 诊断");
  console.log("");
  console.log("进程来源:");
  console.log(`  Launchd 进程标记: ${isLaunchdProcess ? "是" : "否"}`);
  console.log(`  Launchd plist: ${launchdPlist}`);
  console.log(`  Launchd 环境变量: ${Object.keys(launchdEnv).length > 0 ? "已检测到" : "未检测到"}`);

  console.log("\n运行时环境变量:");
  console.log(`  QMD_SILICONFLOW_API_KEY: ${sfKeyRuntime ? "<已设置>" : "<未设置>"}`);
  console.log(`  QMD_GEMINI_API_KEY: ${gmKeyRuntime ? "<已设置>" : "<未设置>"}`);
  console.log(`  QMD_OPENAI_API_KEY: ${oaKeyRuntime ? "<已设置>" : "<未设置>"}`);
  console.log(`  QMD_DASHSCOPE_API_KEY: ${dsKeyRuntime ? "<已设置>" : "<未设置>"}`);
  console.log(`  QMD_EMBED_PROVIDER: ${runtime.QMD_EMBED_PROVIDER || "<未设置>"}`);
  console.log(`  QMD_QUERY_EXPANSION_PROVIDER: ${runtime.QMD_QUERY_EXPANSION_PROVIDER || "<未设置>"}`);
  console.log(`  QMD_RERANK_PROVIDER: ${runtime.QMD_RERANK_PROVIDER || "<未设置>"}`);
  console.log(`  QMD_RERANK_MODE: ${runtime.QMD_RERANK_MODE || "<未设置，默认llm>"}`);
  if (dsKeyRuntime) {
    console.log(`  QMD_DASHSCOPE_RERANK_MODEL: ${runtime.QMD_DASHSCOPE_RERANK_MODEL || "<未设置，默认qwen3-rerank>"}`);
  }
  if (sfKeyRuntime) {
    console.log(`  QMD_SILICONFLOW_EMBED_MODEL: ${runtime.QMD_SILICONFLOW_EMBED_MODEL || "<未设置>"}`);
    console.log(`  QMD_SILICONFLOW_QUERY_EXPANSION_MODEL: ${runtime.QMD_SILICONFLOW_QUERY_EXPANSION_MODEL || "<未设置>"}`);
    console.log(`  QMD_SILICONFLOW_RERANK_MODEL: ${runtime.QMD_SILICONFLOW_RERANK_MODEL || runtime.QMD_SILICONFLOW_MODEL || "<未设置>"}`);
  }
  if (gmKeyRuntime) {
    console.log(`  QMD_GEMINI_MODEL: ${runtime.QMD_GEMINI_RERANK_MODEL || runtime.QMD_GEMINI_MODEL || "<未设置>"}`);
    console.log(`  QMD_GEMINI_BASE_URL: ${runtime.QMD_GEMINI_BASE_URL || "<默认>"}`);
  }
  if (oaKeyRuntime) {
    console.log(`  QMD_OPENAI_MODEL: ${runtime.QMD_OPENAI_MODEL || "<未设置>"}`);
    console.log(`  QMD_OPENAI_BASE_URL: ${runtime.QMD_OPENAI_BASE_URL || "<默认>"}`);
    console.log(`  QMD_OPENAI_EMBED_MODEL: ${runtime.QMD_OPENAI_EMBED_MODEL || "<未设置>"}`);
  }

  if (Object.keys(launchdEnv).length > 0) {
    console.log("\nLaunchd plist 环境变量 (已脱敏):");
    const keysToShow = [
      "QMD_EMBED_PROVIDER",
      "QMD_QUERY_EXPANSION_PROVIDER",
      "QMD_RERANK_PROVIDER",
      "QMD_RERANK_MODE",
      "QMD_SILICONFLOW_EMBED_MODEL",
      "QMD_SILICONFLOW_QUERY_EXPANSION_MODEL",
      "QMD_SILICONFLOW_LLM_RERANK_MODEL",
      "QMD_LLM_RERANK_MODEL",
      "QMD_SILICONFLOW_RERANK_MODEL",
      "QMD_GEMINI_RERANK_MODEL",
      "QMD_SILICONFLOW_API_KEY",
      "QMD_GEMINI_API_KEY",
      "QMD_OPENAI_API_KEY",
      "QMD_DASHSCOPE_API_KEY",
      "QMD_DASHSCOPE_RERANK_MODEL",
    ];
    for (const key of keysToShow) {
      const value = launchdEnv[key];
      if (value !== undefined) {
        const shown = key.includes("API_KEY") ? maskValue(value) : value;
        console.log(`  ${key}: ${shown}`);
      }
    }
  }

  console.log("\n当前生效的 Provider / 模型:");
  console.log(`  向量化 (embed): ${embedProvider || "本地"} → ${embedProvider ? effectiveEmbedModel : "本地 embeddinggemma"}`);
  console.log(`  查询扩展 (query expansion): ${queryExpansionProvider || "本地"} → ${queryExpansionProvider ? effectiveQueryExpansionModel : "本地 qmd-query-expansion"}`);
  const rerankModel = rerankProvider === "siliconflow" ? effectiveSfRerankModel
    : rerankProvider === "gemini" ? effectiveGmModel
    : rerankProvider === "openai" ? effectiveOaModel
    : rerankProvider === "dashscope" ? effectiveDsRerankModel
    : "本地 qwen3-reranker";
  console.log(`  重排序模式: ${rerankMode}`);
  console.log(`  重排序 (rerank): ${rerankProvider || "本地"} → ${rerankModel}`);

  console.log("\n向量索引:");
  console.log(`  数据库维度: ${vecDim || "<缺失>"}`);
  if (probeDim !== null) {
    console.log(`  远程 Embedding 探针维度: ${probeDim}`);
    if (vecDim && Number(vecDim) !== probeDim) {
      console.log(`  诊断: ❌ 维度不匹配 (索引=${vecDim}, 远程=${probeDim})`);
      console.log("  修复: 在相同环境下运行 `qmd embed -f` 重建索引");
    } else {
      console.log("  诊断: ✅ 维度对齐");
    }
  } else if (probeError) {
    console.log(`  远程 Embedding 探针: ❌ 失败 (${probeError})`);
  } else {
    console.log("  远程 Embedding 探针: 跳过（当前进程未启用远程 Embed）");
  }

  if (!isLaunchdProcess && Object.keys(launchdEnv).length > 0) {
    console.log("\n提示:");
    console.log("  当前是从终端运行，不是 OpenClaw launchd 服务。");
    console.log("  环境变量可能与网关进程不同。");
  }

  // 速度诊断
  const hasAnyRemote = !!(sfKeyRuntime || gmKeyRuntime || runtime.QMD_OPENAI_API_KEY);
  if (hasAnyRemote) {
    console.log("\n速度诊断:");
    const SPEED_THRESHOLD_MS = 10000;

    // 测试 embed
    if (embedProvider) {
      const t0 = Date.now();
      try {
        await llmService.embed("QMDR 速度测试", { isQuery: true });
        const elapsed = Date.now() - t0;
        const status = elapsed > SPEED_THRESHOLD_MS ? "⚠️ 慢" : "✅";
        console.log(`  向量化 (${embedProvider}): ${elapsed}ms ${status}`);
        if (elapsed > SPEED_THRESHOLD_MS) {
          console.log(`    → 建议换用更快的非思考模型`);
        }
      } catch (err) {
        console.log(`  向量化 (${embedProvider}): ❌ 失败 - ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log("  向量化: 跳过（本地模式）");
    }

    // 测试 query expansion
    let expansionResult: { type: string; text: string }[] | null = null;
    if (queryExpansionProvider) {
      const t0 = Date.now();
      try {
        expansionResult = await llmService.expandQuery("买过哪些日本的VPS服务器") as { type: string; text: string }[];
        const elapsed = Date.now() - t0;
        const status = elapsed > SPEED_THRESHOLD_MS ? "⚠️ 慢" : "✅";
        console.log(`  查询扩展 (${queryExpansionProvider}): ${elapsed}ms ${status}`);
        if (elapsed > SPEED_THRESHOLD_MS) {
          console.log(`    → 建议换用更快的非思考模型`);
        }
      } catch (err) {
        console.log(`  查询扩展 (${queryExpansionProvider}): ❌ 失败 - ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log("  查询扩展: 跳过（本地模式）");
    }

    // 测试 rerank
    if (rerankProvider) {
      const t0 = Date.now();
      try {
        await llmService.rerank("买过哪些日本的VPS服务器", [
          { file: "memory/2026-01-15.md", text: "在绿云买了一台东京软银VPS，4C8G，三年$88，用来做备用机。" },
          { file: "memory/2026-01-20.md", text: "今天做了一顿咖喱鸡，味道还不错。" },
        ]);
        const elapsed = Date.now() - t0;
        const status = elapsed > SPEED_THRESHOLD_MS ? "⚠️ 慢" : "✅";
        console.log(`  重排序 (${rerankProvider}): ${elapsed}ms ${status}`);
        if (elapsed > SPEED_THRESHOLD_MS) {
          console.log(`    → 建议换用更快的非思考模型`);
        }
      } catch (err) {
        console.log(`  重排序 (${rerankProvider}): ❌ 失败 - ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log("  重排序: 跳过（本地模式）");
    }

    console.log(`\n  建议: 每个步骤应在 ${SPEED_THRESHOLD_MS / 1000} 秒内完成。`);
    console.log("  如果慢，请尝试非思考或更小的模型。");
  } else {
    console.log("\n速度诊断: 跳过（未配置远程 Provider）");
  }

  // --bench 评分模式
  if (bench && hasAnyRemote && queryExpansionProvider && rerankProvider) {
    console.log("\n质量评估 (--bench):");
    // 评委优先用 Gemini（最强），其次 OpenAI，最后 SiliconFlow
    let judgeProvider: "gemini" | "siliconflow" | "openai" = "siliconflow";
    let judgeApiKey = sfKeyRuntime || "";
    let judgeBaseUrl = (runtime.QMD_SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
    let judgeModel = runtime.QMD_SILICONFLOW_QUERY_EXPANSION_MODEL || "zai-org/GLM-4.5-Air";

    if (gmKeyRuntime) {
      judgeProvider = "gemini";
      judgeApiKey = gmKeyRuntime;
      judgeBaseUrl = (runtime.QMD_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
      judgeModel = runtime.QMD_GEMINI_MODEL || "gemini-2.5-flash";
    } else if (oaKeyRuntime) {
      judgeProvider = "openai";
      judgeApiKey = oaKeyRuntime;
      judgeBaseUrl = (runtime.QMD_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
      judgeModel = runtime.QMD_OPENAI_MODEL || "gpt-4o-mini";
    }
    console.log(`  评委模型: ${judgeModel} (${judgeProvider})`);
    console.log("  对查询扩展结果评分...\n");

    const benchQueries = [
      "昨天讨论了什么话题",
      "前天我让你装了什么 skill",
      "如何配置环境变量",
    ];

    let totalScore = 0;
    let totalTests = 0;

    for (const q of benchQueries) {
      console.log(`  查询: "${q}"`);
      try {
        const expanded = await llmService.expandQuery(q) as { type: string; text: string }[];
        const lexItems = expanded.filter((e: { type: string }) => e.type === "lex");
        const vecItems = expanded.filter((e: { type: string }) => e.type === "vec");
        const hydeItems = expanded.filter((e: { type: string }) => e.type === "hyde");

        const expandedText = expanded.map((e: { type: string; text: string }) => `${e.type}: ${e.text}`).join("\n");
        console.log(`    扩展结果 (lex:${lexItems.length} vec:${vecItems.length} hyde:${hydeItems.length}):`);
        for (const e of expanded) {
          console.log(`      ${e.type}: ${(e.text || "").slice(0, 80)}`);
        }

        // 用 chat completions 直接评分
        const evalPrompt = `对以下查询扩展结果评分（0-10分）。

原始查询: "${q}"
扩展结果:
${expandedText}

评分标准:
- lex 是否为空格分隔的关键词（不是句子）？
- vec 是否是语义相关的改写？
- hyde 是否像一段真实的文档内容？
- 整体是否覆盖了查询的核心意图？

请只输出一个数字（0-10），不要其他内容。`;

        let score = -1;
        if (judgeApiKey) {
          try {
            // Gemini 原生 API 格式不同，统一走 OpenAI-compatible endpoint
            const chatUrl = judgeProvider === "gemini"
              ? `${judgeBaseUrl}/v1/chat/completions`
              : `${judgeBaseUrl}/chat/completions`;
            const scoreResp = await fetch(chatUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${judgeApiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: judgeModel,
                messages: [{ role: "user", content: evalPrompt }],
                max_tokens: 10,
                temperature: 0,
              }),
            });
            if (scoreResp.ok) {
              const scoreData = await scoreResp.json() as { choices?: Array<{ message?: { content?: string } }> };
              const scoreText = scoreData.choices?.[0]?.message?.content || "";
              const scoreMatch = scoreText.match(/(\d+)/);
              score = scoreMatch ? Math.min(10, parseInt(scoreMatch[1]!)) : -1;
            }
          } catch {}
        }

        if (score >= 0) {
          console.log(`    评分: ${score}/10 ${"★".repeat(Math.round(score / 2))}${"☆".repeat(5 - Math.round(score / 2))}`);
          totalScore += score;
          totalTests++;
        } else {
          console.log(`    评分: 无法解析`);
        }
      } catch (err) {
        console.log(`    ❌ 失败: ${err instanceof Error ? err.message : err}`);
      }
      console.log("");
    }

    if (totalTests > 0) {
      const avg = (totalScore / totalTests).toFixed(1);
      console.log(`  综合评分: ${avg}/10 (${totalTests} 题)`);
      if (Number(avg) >= 8) console.log("  评价: 🌟 优秀");
      else if (Number(avg) >= 6) console.log("  评价: 👍 良好");
      else if (Number(avg) >= 4) console.log("  评价: ⚠️ 一般，建议换更好的模型");
      else console.log("  评价: ❌ 较差，建议更换模型");
    }
  } else if (bench && !hasAnyRemote) {
    console.log("\n质量评估: 跳过（未配置远程 Provider）");
  } else if (bench && !queryExpansionProvider) {
    console.log("\n质量评估: 跳过（未配置查询扩展 Provider）");
  }

  closeDb();
}

// Main CLI - only run if this is the main module
if (import.meta.main) {
  const cli = parseCLI();

  if (!cli.command || cli.values.help) {
    showHelp();
    process.exit(cli.values.help ? 0 : 1);
  }

  const timeoutRaw = (cli.values as Record<string, unknown>).timeout;
  if ((cli.command === "query" || cli.command === "embed") && timeoutRaw !== undefined) {
    const timeoutMs = parseTimeoutFlagToMs(timeoutRaw);
    if (timeoutMs === null) {
      console.error(`Invalid --timeout value: ${String(timeoutRaw)} (examples: 30s, 30000ms, 1m, 15000)`);
      process.exit(1);
    }
    process.env.QMD_TIMEOUT_MS = String(timeoutMs);
  }

  switch (cli.command) {
    case "context":
      await handleContextCommand(cli.args, { contextAdd, contextList, contextCheck, contextRemove });
      break;

    case "get":
      handleGetCommand(cli.args, cli.values as Record<string, unknown>, cli.opts, { getDocument });
      break;

    case "multi-get":
      handleMultiGetCommand(cli.args, cli.values as Record<string, unknown>, cli.opts.format, DEFAULT_MULTI_GET_MAX_BYTES, { multiGet });
      break;

    case "ls":
      handleLsCommand(cli.args, { listFiles });
      break;

    case "collection":
      await handleCollectionCommand(cli.args, cli.values as Record<string, unknown>, {
        getPwd,
        getRealPath,
        resolve,
        defaultGlob: DEFAULT_GLOB,
        collectionList,
        collectionAdd,
        collectionRemove,
        collectionRename,
      });
      break;

    case "status":
      handleStatusCommand({ showStatus });
      break;

    case "update":
      await handleUpdateCommand(cli.values as Record<string, unknown>, { updateCollections });
      break;

    case "embed":
      await handleEmbedCommand(cli.values as Record<string, unknown>, { vectorIndex, defaultModel: DEFAULT_EMBED_MODEL });
      break;

    case "search":
      handleSearchCommand(cli.query, cli.opts, { search });
      break;

    case "vsearch":
      await handleVSearchCommand(cli.query, cli.values as Record<string, unknown>, cli.opts, { vectorSearch });
      break;

    case "query":
      await handleQueryCommand(cli.query, cli.opts, { querySearch });
      break;

    case "mcp": {
      const { startMcpServer } = await import("./mcp.js");
      await handleMcpCommand({ startMcpServer });
      break;
    }

    case "cleanup": {
      handleCleanupCommand({ cleanup: cleanupCommand });
      break;
    }

    case "doctor": {
      const bench = !!(cli.values as Record<string, unknown>).bench;
      await handleDoctorCommand({ doctor: doctorCommand }, bench);
      break;
    }

    default:
      console.error(`Unknown command: ${cli.command}`);
      console.error("Run 'qmd --help' for usage.");
      process.exit(1);
  }

  if (cli.command !== "mcp") process.exit(0);

} // end if (import.meta.main)
