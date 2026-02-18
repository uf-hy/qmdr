import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, hashContent, searchVec, type Store } from "./store.js";
import type { ILLMSession, Queryable, RerankDocument, RerankResult } from "./llm.js";

function createMockEmbedSession(embedding: number[], model: string = "mock"): ILLMSession {
  const ac = new AbortController();

  return {
    async embed(_text: string, _options?: { model?: string; isQuery?: boolean; title?: string }) {
      return { embedding, model };
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => ({ embedding, model }));
    },
    async expandQuery(query: string, _options?: { context?: string; includeLexical?: boolean }): Promise<Queryable[]> {
      return [{ type: "lex", text: query }];
    },
    async rerank(_query: string, documents: RerankDocument[], _options?: { model?: string }): Promise<RerankResult> {
      return {
        model,
        results: documents.map((d, i) => ({ file: d.file, score: 0, index: i })),
      };
    },
    isValid: true,
    signal: ac.signal,
  };
}

let store: Store;
let testDir: string;

beforeAll(async () => {
  // Ensure these tests never hit remote embedding providers.
  delete process.env.QMD_SILICONFLOW_API_KEY;
  delete process.env.QMD_GEMINI_API_KEY;
  delete process.env.QMD_OPENAI_API_KEY;

  testDir = await mkdtemp(join(tmpdir(), "qmd-store-filter-"));
  store = createStore(join(testDir, "index.sqlite"));
});

afterAll(async () => {
  store.close();
  await rm(testDir, { recursive: true, force: true });
});

describe("searchFTS collection filter", () => {
  test("multiple collection names returns the union", async () => {
    const now = new Date().toISOString();

    const bodyA = "unicorn from A";
    const hashA = await hashContent(bodyA);
    store.insertContent(hashA, bodyA, now);
    store.insertDocument("a", "a.md", "A", hashA, now, now);

    const bodyB = "unicorn from B";
    const hashB = await hashContent(bodyB);
    store.insertContent(hashB, bodyB, now);
    store.insertDocument("b", "b.md", "B", hashB, now, now);

    const onlyA = store.searchFTS("unicorn", 20, ["a"]);
    expect(new Set(onlyA.map(r => r.collectionName))).toEqual(new Set(["a"]));

    const onlyB = store.searchFTS("unicorn", 20, ["b"]);
    expect(new Set(onlyB.map(r => r.collectionName))).toEqual(new Set(["b"]));

    const union = store.searchFTS("unicorn", 20, ["a", "b"]);
    expect(new Set(union.map(r => r.collectionName))).toEqual(new Set(["a", "b"]));
  });
});

describe("searchVec collection filter", () => {
  test("multiple collection names returns the union", async () => {
    const now = new Date().toISOString();

    // Ensure this test is self-contained even if other tests inserted vectors.
    store.clearAllEmbeddings();

    // Keep embeddings tiny + deterministic.
    const queryEmbedding = [1, 0, 0];
    store.ensureVecTable(queryEmbedding.length);

    const bodyA = "unicorn from A (vec)";
    const hashA = await hashContent(bodyA);
    store.insertContent(hashA, bodyA, now);
    store.insertDocument("a", "a-vec.md", "A (vec)", hashA, now, now);
    store.insertEmbedding(hashA, 0, 0, new Float32Array(queryEmbedding), "test-model", now);

    const bodyB = "unicorn from B (vec)";
    const hashB = await hashContent(bodyB);
    store.insertContent(hashB, bodyB, now);
    store.insertDocument("b", "b-vec.md", "B (vec)", hashB, now, now);
    store.insertEmbedding(hashB, 0, 0, new Float32Array(queryEmbedding), "test-model", now);

    const session = createMockEmbedSession(queryEmbedding, "test-model");

    const onlyA = await searchVec(store.db, "unicorn", "test-model", 20, ["a"], session);
    expect(new Set(onlyA.map(r => r.collectionName))).toEqual(new Set(["a"]));

    const onlyB = await searchVec(store.db, "unicorn", "test-model", 20, ["b"], session);
    expect(new Set(onlyB.map(r => r.collectionName))).toEqual(new Set(["b"]));

    const union = await searchVec(store.db, "unicorn", "test-model", 20, ["a", "b"], session);
    expect(new Set(union.map(r => r.collectionName))).toEqual(new Set(["a", "b"]));
  });
});
