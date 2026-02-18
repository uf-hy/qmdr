import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, hashContent, type Store } from "./store.js";

let store: Store;
let testDir: string;

beforeAll(async () => {
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
