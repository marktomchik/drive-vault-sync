import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outfile = path.join(tmpdir(), `dvs-test-progress-${Date.now()}.mjs`);
await build({ entryPoints: ["src/progress.ts"], outfile, bundle: true, platform: "node", format: "esm" });
const { SyncProgressTracker, progressPercent, isIndeterminate } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);

test("tracks stages, transfers, counters and errors", () => {
  const emitted = [];
  const tracker = new SyncProgressTracker((state) => emitted.push(state.stage));
  tracker.begin("Sync");
  assert.equal(tracker.getState().active, true);
  assert.equal(isIndeterminate(tracker.getState()), true);

  tracker.setScanProgress(5, 10);
  assert.equal(tracker.getState().stage, "scanning");
  assert.equal(progressPercent(tracker.getState()), 50);

  tracker.setStage("transferring", "Transferring files…");
  tracker.growTotalBy(3);
  tracker.start("a.md", "upload");
  tracker.finish("a.md");
  tracker.start("b.md", "download");
  tracker.finish("b.md", "error", "HTTP 500");
  tracker.markDone("c.md", "delete-remote");

  const state = tracker.getState();
  assert.equal(state.completed, 3);
  assert.equal(state.total, 3);
  assert.equal(state.counts.upload, 1);
  assert.equal(state.counts["delete-remote"], 1);
  assert.equal(state.counts.error, 1);
  assert.equal(state.items.find((item) => item.path === "b.md").detail, "HTTP 500");
  assert.equal(progressPercent(state), 100);
  assert.ok(emitted.length > 0);
});

test("fail() reuses an existing error row instead of double counting", () => {
  const tracker = new SyncProgressTracker(() => undefined);
  tracker.begin();
  tracker.setStage("transferring", "");
  tracker.start("x.md", "upload");
  tracker.finish("x.md", "error", "first");
  tracker.fail("x.md", "final message");
  const state = tracker.getState();
  assert.equal(state.counts.error, 1);
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].detail, "final message");

  tracker.fail("y.md", "never started", "download");
  assert.equal(tracker.getState().counts.error, 2);
});

test("end() keeps rows visible and closes unfinished ones", () => {
  const tracker = new SyncProgressTracker(() => undefined);
  tracker.begin();
  tracker.start("slow.md", "upload");
  tracker.end("Network down");
  const state = tracker.getState();
  assert.equal(state.active, false);
  assert.equal(state.error, "Network down");
  assert.equal(state.items[0].status, "error");
});
