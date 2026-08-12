# Reel Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent routine engine, cache, and subprocess lifecycle issues from turning each reel run into a long repair cycle.

**Architecture:** Keep the existing project contract and approval boundaries, but split implementation fingerprints by pipeline stage, make render staging disposable, and route external tools through one owned-process runner with bounded cancellation. Each change is independently tested and committed so it can be reviewed or reverted without disturbing completed reel projects.

**Tech Stack:** Node.js 24.12, TypeScript 5.9, Vitest 4.1, Remotion 4.0.507, FFmpeg/FFprobe, Python 3.11, POSIX process groups.

## Global Constraints

- Do not alter rights, rough-cut, color, QC, codec, or delivery policy.
- Existing manifests and projects must remain readable without migration.
- Cache invalidation must be conservative within a stage but must not cascade from unrelated CLI or Doctor changes.
- Scratch cleanup may remove only engine-owned paths below `public/jobs/<reel>/` and the raw file created for the current render.
- Preserve a raw render when publication fails; remove it only after the published artifact is recorded successfully.
- Process cleanup may signal only the exact process group created by the current invocation.
- Long FFmpeg jobs have no arbitrary wall-clock limit; use an idle limit, while short probes and Doctor checks use explicit wall-clock limits.
- Use Node 24.12 for every JavaScript command in this worktree.

---

### Task 1: Stage-Scoped Implementation Fingerprints

**Files:**
- Create: `src/core/implementation-fingerprint.ts`
- Create: `tests/unit/implementation-fingerprint.test.ts`
- Modify: `src/render/artifacts.ts`
- Modify: `src/media/proxy.ts`
- Modify: `src/media/grade.ts`
- Modify: relevant fingerprint mocks/assertions in existing tests

- [x] **Step 1: Write failing isolation tests**

Cover these invariants with an injected virtual file reader:

```ts
const first = await implementationFingerprint('proxy', fixture);
fixture.files.set('src/cli.ts', 'unrelated change');
expect(await implementationFingerprint('proxy', fixture)).toBe(first);
fixture.files.set('src/media/proxy.ts', 'relevant change');
expect(await implementationFingerprint('proxy', fixture)).not.toBe(first);
```

Also prove that Remotion component changes invalidate `render` but not `proxy`, and proxy changes invalidate `proxy` but not `render`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/implementation-fingerprint.test.ts`

Expected: FAIL because the scoped fingerprint API does not exist.

- [x] **Step 3: Implement explicit stage dependency sets**

Provide `implementationFingerprint(scope, options?)` for `proxy`, `stabilize`, `grade`, `preview`, `master`, and `delivery`. Hash a versioned, sorted manifest of only the source/configuration dependency graph and package versions that can affect that stage. Do not hash generated outputs, project media, the CLI dispatcher, Doctor, tests, plans, or repository metadata.

- [x] **Step 4: Replace the global build fingerprint**

Use `proxy` and `grade` scopes in the corresponding media fingerprints. Use `render` for preview/master Remotion artifacts and `delivery` for delivery post-processing. Remove the full-`src` fingerprint implementation after all callers are migrated.

- [x] **Step 5: Verify focused and affected tests**

Run: `npx vitest run tests/unit/implementation-fingerprint.test.ts tests/unit/preview-stabilize-fallback.test.ts tests/unit/render-artifacts.test.ts tests/unit/edit-approval.test.ts tests/integration/media-pipeline.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Commit: `fix(cache): scope reel fingerprints by pipeline stage`

---

### Task 2: Disposable Render Scratch Space

**Files:**
- Create: `src/render/scratch.ts`
- Create: `tests/unit/render-scratch.test.ts`
- Modify: `src/render/stage.ts`
- Modify: `src/render/remotion.ts`
- Modify: `tests/unit/remotion-supervisor.test.ts`

- [ ] **Step 1: Write failing cleanup and path-safety tests**

Cover:

- stale fingerprint directories for the current reel are pruned;
- another reel and any path outside `public/jobs` are never removed;
- a staged file uses a hard link when source and destination share a filesystem;
- the raw Remotion file disappears only after successful artifact publication;
- publication failure retains the raw file for recovery.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/render-scratch.test.ts tests/unit/remotion-supervisor.test.ts`

Expected: FAIL on missing scratch lifecycle behavior.

- [ ] **Step 3: Implement safe stage lifecycle helpers**

Resolve and validate every deletion target beneath `<engineRoot>/public/jobs/<reel>/`. Prune stale sibling fingerprints before staging and remove the current fingerprint directory in `renderTarget()`'s `finally` block after the supervised worker has settled.

- [ ] **Step 4: Prefer hard links for immutable staged inputs**

Create each temporary staged output with `link()`, validate it through the existing atomic-output contract, and fall back to `copyFile()` only for expected cross-device, unsupported, or link-limit errors.

- [ ] **Step 5: Remove published raw render intermediates**

Unlink `work/render/*-remotion.*` after and only after `recordArtifact()` succeeds. Leave it intact when conversion, validation, or artifact publication throws.

- [ ] **Step 6: Verify focused tests**

Run: `npx vitest run tests/unit/render-scratch.test.ts tests/unit/remotion-supervisor.test.ts tests/unit/atomic-output.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Commit: `fix(render): clean disposable render scratch files`

---

### Task 3: Bounded Owned-Process Execution

**Files:**
- Create: `tests/fixtures/process-runner-tree.ts`
- Create: `tests/unit/media-process.test.ts`
- Modify: `src/media/process.ts`
- Modify: `src/media/ffmpeg.ts`
- Modify: `src/commands/doctor.ts`
- Modify: Python/music command callers where applicable

- [ ] **Step 1: Write failing lifecycle tests**

Exercise a successful command, a non-zero command, an idle timeout, an explicit abort, and a parent that exits while leaving a descendant in its process group. Assert the exact owned group is empty after every terminal path and an unrelated sentinel is alive.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run tests/unit/media-process.test.ts`

Expected: FAIL because `runProcess()` has no timeout, abort, or owned-group contract.

- [ ] **Step 3: Implement bounded execution on the existing process-group primitives**

Extend `runProcess()` with `timeoutMs`, `idleTimeoutMs`, `signal`, and bounded captured output. Reset the idle timer for either output stream. On timeout, abort, spawn error, or surviving descendants, stop only the owned PGID and await cleanup before rejecting. Preserve command, exit code/signal, and a bounded stdout/stderr tail in errors.

- [ ] **Step 4: Migrate critical callers with appropriate policies**

Use explicit wall-clock limits for FFprobe and Doctor checks, an idle limit for FFmpeg, and a bounded wall-clock limit for Python/librosa analysis. Keep long render supervision on its existing specialized worker protocol.

- [ ] **Step 5: Verify focused tests and interruption behavior**

Run: `npx vitest run tests/unit/media-process.test.ts tests/unit/ffmpeg.test.ts tests/unit/doctor.test.ts tests/unit/process-group.test.ts`

Expected: PASS with no owned descendants left behind.

- [ ] **Step 6: Commit Task 3**

Commit: `fix(process): bound external reel commands`

---

### Task 4: Repository Verification and Review

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Run the complete unit/integration suite**

Run: `npm test`

Expected: all engine tests pass; the existing fresh-worktree Doctor LUT-library assertion may remain a documented fixture/environment warning because ignored LUT assets are intentionally absent.

- [ ] **Step 3: Run representative synthetic validation**

Run the smallest repository-provided synthetic render/QC command that exercises proxy, grade, render, and cleanup without requiring user media. Compare process inventory before and after.

- [ ] **Step 4: Review the complete branch diff**

Check deletion boundaries, cache dependency coverage, error preservation, compatibility, and repository cleanliness. Fix any material issue and rerun affected verification.

- [ ] **Step 5: Update the reel skill troubleshooting guidance if behavior changed**

Document only stable user-facing recovery behavior. Do not add redundant manual repair steps that the engine now handles automatically.
