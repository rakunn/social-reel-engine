# Remotion Process Lifecycle Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every macOS Remotion render own, await, and verify cleanup of the browser and native descendants it creates before registering a fresh artifact.

**Architecture:** Keep validation, fingerprints, post-processing, and artifact registration in the current render module. Move bundling, composition selection, and raw Remotion rendering into a dedicated worker process group; explicitly own the Remotion browser inside that worker, and let a parent supervisor cancel and clean only the worker's process group. Treat existing PID-1 `UE` processes as a read-only validation baseline.

**Tech Stack:** Node.js 24.12, TypeScript 5.9, Vitest 4.1, Remotion 4.0.507, POSIX process groups/signals, FFmpeg, Zod 4.4.

## Global Constraints

- Automatic cleanup applies only to processes created for the current render.
- Never select signal targets by matching `remotion`, `ffprobe`, FFmpeg, or Chrome command names.
- Concurrent renders must have independent worker and browser process groups.
- Use 10 seconds for graceful cancellation, 5 seconds after `SIGTERM`, and 5 seconds after `SIGKILL`; tests may inject shorter durations.
- Await bounded explicit Chrome closure; verify its separately detached browser group as well as the worker group used by inherited bundler, compositor, probing, and encoding descendants.
- Do not register or refresh an artifact when worker cleanup is incomplete.
- Preserve the original render error and append exact process-group/PID/state cleanup diagnostics.
- Do not alter edit approval, color approval, rights, fingerprint, Rec.709, codec, delivery, or QC policy.
- Leave the five existing PID-1 `UE` processes untouched and prove validation adds no new stale jobs.
- Leave the unrelated untracked `.idea/` directory untouched and unstaged.

## File Map

- Create `src/render/process-group.ts`: POSIX-owned child spawning, exact-PGID inspection, bounded wait, escalation, and cleanup errors.
- Create `src/render/remotion-worker.ts`: worker request/result schemas, an owned Chrome launcher, explicit browser and cancellation lifecycle, signal handling, and worker entrypoint.
- Create `src/render/remotion-supervisor.ts`: request/result/browser-PGID files, dual-group supervision, parent-signal forwarding, error composition, and temporary-file cleanup.
- Modify `src/render/remotion.ts`: delegate only the raw Remotion phase, then post-process and register artifacts after verified cleanup.
- Modify `src/cli.ts`: preserve signal-derived exit status for an interrupted render.
- Create `tests/fixtures/process-tree-worker.ts`: deterministic inherited descendants and a stubborn interruptible child.
- Create `tests/fixtures/run-remotion-request.ts`: signalable wrapper used by the real cancellation test.
- Create `tests/unit/process-group.test.ts`: ownership, escalation, diagnostics, and unrelated-process safety.
- Create `tests/unit/remotion-worker.test.ts`: browser reuse, cancellation wiring, awaited closure, and combined errors.
- Create `tests/unit/remotion-supervisor.test.ts`: worker results, interruption, exact cleanup, and artifact-boundary sequencing.
- Create `tests/helpers/remotion-process-inventory.ts`: read-only macOS process inventory used only for baseline comparison.
- Create `tests/unit/remotion-process-inventory.test.ts`: exact worker-to-browser ancestry checks against baseline and concurrent processes.
- Modify `scripts/synthetic-e2e.ts`: expose synthetic-project preparation without changing existing acceptance behavior.
- Create `tests/e2e/remotion-cleanup.test.ts`: real successful render and forced-cancellation process-inventory validation.
- Modify `package.json`: serialize E2E files so process-baseline assertions cannot observe another healthy acceptance render.

---

### Task 1: Owned POSIX Process-Group Primitives

**Files:**
- Create: `src/render/process-group.ts`
- Create: `tests/fixtures/process-tree-worker.ts`
- Create: `tests/unit/process-group.test.ts`

**Interfaces:**
- Consumes: Node `spawn()`, `process.kill()`, and read-only `ps -ax -o pid=,ppid=,pgid=,stat=,command=` output.
- Produces: `spawnOwnedProcess()`, `listProcessGroupMembers()`, `waitForProcessGroupExit()`, `stopOwnedProcessGroup()`, `OwnedProcessCleanupError`, `CleanupTimeouts`, and `ProcessGroupMember`.

- [ ] **Step 1: Write failing tests for group ownership and exact cleanup**

Create a fixture whose worker and descendants inherit one group, while an unrelated sentinel leads a different group. Cover normal worker exit with a surviving descendant, an error exit, and a descendant that ignores `SIGTERM`:

```ts
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
  listProcessGroupMembers,
  spawnOwnedProcess,
  stopOwnedProcessGroup,
} from '../../src/render/process-group';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(root, 'tests/fixtures/process-tree-worker.ts');
const sentinels: number[] = [];

afterEach(() => {
  for (const pid of sentinels.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
});

describe.runIf(process.platform !== 'win32')('owned process groups', () => {
  it('removes only descendants in the owned group', async () => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    sentinels.push(sentinel.pid!);
    const owned = spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', fixture, 'leave-child'],
      cwd: root,
    });
    await owned.closed;

    expect(await listProcessGroupMembers(owned.pgid!)).not.toEqual([]);
    await stopOwnedProcessGroup(owned.pgid!, {
      termMs: 500,
      killMs: 500,
      pollMs: 20,
    });

    expect(await listProcessGroupMembers(owned.pgid!)).toEqual([]);
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  });

  it('escalates a stubborn owned descendant to SIGKILL', async () => {
    const owned = spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', fixture, 'ignore-term'],
      cwd: root,
    });
    await owned.closed;
    await stopOwnedProcessGroup(owned.pgid!, {
      termMs: 50,
      killMs: 500,
      pollMs: 20,
    });
    expect(await listProcessGroupMembers(owned.pgid!)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/unit/process-group.test.ts`

Expected: FAIL because `src/render/process-group.ts` and its exported lifecycle functions do not exist.

- [ ] **Step 3: Implement exact-PGID inspection and escalation**

Implement these public shapes and constants. Parse `ps` columns numerically and retain the remainder as the command; filtering is exclusively `member.pgid === pgid`:

```ts
export type ProcessGroupMember = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  command: string;
};

export type CleanupTimeouts = {
  termMs: number;
  killMs: number;
  pollMs: number;
};

export const DEFAULT_CLEANUP_TIMEOUTS: CleanupTimeouts = {
  termMs: 5_000,
  killMs: 5_000,
  pollMs: 100,
};

export type OwnedProcess = {
  child: import('node:child_process').ChildProcessWithoutNullStreams;
  pid: number;
  pgid: number | null;
  closed: Promise<{exitCode: number | null; signal: NodeJS.Signals | null}>;
};

export class OwnedProcessCleanupError extends Error {
  constructor(
    readonly pgid: number,
    readonly members: ProcessGroupMember[],
  ) {
    super(
      `Process group ${pgid} did not exit: ${members
        .map((member) => `${member.pid} ${member.state} ${member.command}`)
        .join('; ')}`,
    );
  }
}
```

`spawnOwnedProcess()` must set `detached: process.platform !== 'win32'`, use piped stdout/stderr, reject a missing PID, and expose one stable `closed` promise. `stopOwnedProcessGroup()` must inspect the exact PGID, send `SIGTERM` to `-pgid`, poll until `termMs`, send `SIGKILL` only when members remain, poll until `killMs`, and throw `OwnedProcessCleanupError` with the final members when the group is still present. `ESRCH` means the owned group has already exited; `EPERM` remains an error.

The fixture must use `spawn(process.execPath, ['-e', source], {stdio: 'ignore'})` without `detached`, print the child PID, and let the worker exit. In `ignore-term` mode the child installs `process.on('SIGTERM', () => undefined)` so the escalation path is deterministic.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run tests/unit/process-group.test.ts`

Expected: PASS with the owned groups empty and the unrelated sentinel still alive.

- [ ] **Step 5: Run type checking**

Run: `npm run typecheck`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/render/process-group.ts tests/fixtures/process-tree-worker.ts tests/unit/process-group.test.ts
git commit -m "feat: add owned render process groups"
```

---

### Task 2: Explicit Remotion Worker Lifecycle

**Files:**
- Create: `src/render/remotion-worker.ts`
- Create: `tests/unit/remotion-worker.test.ts`

**Interfaces:**
- Consumes: `RenderSettings`, `RenderTarget`, staged input props, `bundle()`, `openBrowser()`, `selectComposition()`, `renderMedia()`, and `makeCancelSignal()`.
- Produces: `RemotionWorkerRequestSchema`, `RemotionWorkerResultSchema`, `runRawRemotionRender()`, `installWorkerSignalHandlers()`, and the directly invokable worker entrypoint.

- [ ] **Step 1: Write failing tests for browser ownership and cancellation**

Use dependency injection rather than mocking child-process behavior. The test browser's close promise remains pending until the test resolves it, proving the worker awaits cleanup:

```ts
import {EventEmitter} from 'node:events';
import {describe, expect, it, vi} from 'vitest';
import {
  installWorkerSignalHandlers,
  runRawRemotionRender,
  type RemotionWorkerRequest,
} from '../../src/render/remotion-worker';
import {DEFAULT_RENDER_SETTINGS} from '../../src/render/policy';

const request: RemotionWorkerRequest = {
  schemaVersion: '1.0.0',
  engineRoot: '/engine',
  target: 'preview',
  rawOutput: '/project/work/render/preview-remotion.mp4',
  inputProps: {reelName: 'lifecycle-test'},
  settings: DEFAULT_RENDER_SETTINGS,
};

describe('Remotion worker lifecycle', () => {
  it('reuses one browser and awaits its closure', async () => {
    let releaseClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; }));
    const browser = {close};
    const selectComposition = vi.fn(async () => ({id: 'SocialReel'}));
    const renderMedia = vi.fn(async () => undefined);
    let settled = false;
    const running = runRawRemotionRender(request, {
      bundle: vi.fn(async () => '/bundle'),
      openBrowser: vi.fn(async () => browser),
      selectComposition,
      renderMedia,
    }).then(() => { settled = true; });

    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({silent: true}));
    expect(settled).toBe(false);
    expect(selectComposition).toHaveBeenCalledWith(
      expect.objectContaining({puppeteerInstance: browser}),
    );
    expect(renderMedia).toHaveBeenCalledWith(
      expect.objectContaining({puppeteerInstance: browser, cancelSignal: expect.any(Function)}),
    );
    releaseClose();
    await running;
  });

  it('cancels on signals and removes every installed handler', () => {
    const emitter = new EventEmitter();
    const cancel = vi.fn();
    const installed = installWorkerSignalHandlers(cancel, emitter);
    emitter.emit('SIGTERM');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(installed.receivedSignal()).toBe('SIGTERM');
    installed.remove();
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
    expect(emitter.listenerCount('SIGHUP')).toBe(0);
  });
});
```

Add a rejection case that expects an `AggregateError` containing both the original `renderMedia()` failure and an explicit `browser.close()` failure.

- [ ] **Step 2: Run the worker tests and verify RED**

Run: `npx vitest run tests/unit/remotion-worker.test.ts`

Expected: FAIL because the Remotion worker module and lifecycle interfaces do not exist.

- [ ] **Step 3: Implement the request/result protocol and raw worker**

Define a Zod-backed request using the existing `RenderSettingsSchema` and a discriminated result:

```ts
export const RemotionWorkerRequestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  engineRoot: z.string().min(1),
  target: z.enum(['preview', 'master']),
  rawOutput: z.string().min(1),
  inputProps: z.record(z.string(), z.unknown()),
  settings: RenderSettingsSchema,
});

export const RemotionWorkerResultSchema = z.discriminatedUnion('ok', [
  z.object({schemaVersion: z.literal('1.0.0'), ok: z.literal(true)}),
  z.object({
    schemaVersion: z.literal('1.0.0'),
    ok: z.literal(false),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP']).nullable(),
    error: z.object({message: z.string(), stack: z.string().nullable()}),
  }),
]);
```

`runRawRemotionRender()` must:

1. Bundle `src/remotion/index.ts` with the current `publicDir`, root, cache, and symlink settings.
2. Stop before opening Chrome when cancellation arrived during bundling.
3. Resolve the pinned Chrome executable, create a per-render launcher that records its own detached PGID before starting Chrome in that group, and pass the launcher as `browserExecutable` to `openBrowser()`.
4. Pass that browser to `selectComposition()` and `renderMedia()` as `puppeteerInstance`.
5. Pass the `makeCancelSignal().cancelSignal` to `renderMedia()`.
6. Preserve every current codec, pixel format, audio, color, scale, timeout, and target-specific render option.
7. Await `browser.close({silent: true})` with a bounded timeout in all paths so the supervisor can finish exact-group verification.
8. Preserve nested render and close errors in the worker protocol, and throw the original error, the close error, or `AggregateError([renderError, closeError], 'Remotion render and browser cleanup both failed')` as applicable.

The executable entrypoint reads request/result paths from `process.argv[2]` and `process.argv[3]`, installs `SIGINT`, `SIGTERM`, and `SIGHUP` handlers, runs the raw render, atomically writes a schema-valid result with `writeJson()`, removes handlers, and sets `process.exitCode` to `0`, `1`, `130`, `143`, or `129` without calling `process.exit()`.

- [ ] **Step 4: Run the worker tests and verify GREEN**

Run: `npx vitest run tests/unit/remotion-worker.test.ts`

Expected: PASS, including proof that browser closure is awaited and signal listeners are removed.

- [ ] **Step 5: Run type checking and existing Remotion data tests**

Run: `npm run typecheck`

Run: `npx vitest run tests/unit/remotion-data.test.ts tests/unit/render-policy.test.ts`

Expected: PASS with current rendering policy unchanged.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/render/remotion-worker.ts tests/unit/remotion-worker.test.ts
git commit -m "feat: own Remotion worker resources"
```

---

### Task 3: Supervisor, Interruption, and Artifact Gate

**Files:**
- Create: `src/render/remotion-supervisor.ts`
- Modify: `src/render/remotion.ts`
- Modify: `src/cli.ts`
- Create: `tests/unit/remotion-supervisor.test.ts`

**Interfaces:**
- Consumes: Task 1's owned-process primitives and Task 2's request/result schemas.
- Produces: `superviseRemotionRender(request, options?)`, `RenderInterruptedError`, `exitCodeForRenderError()`, and a testable `finalizeRawRender()` sequencing boundary.

- [ ] **Step 1: Write failing supervisor and artifact-order tests**

Test a successful worker result, a worker error plus cleanup diagnostics, and an interruption. Also test the exact side-effect order around artifact registration:

```ts
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {finalizeRawRender} from '../../src/render/remotion';
import {
  exitCodeForRenderError,
  RenderInterruptedError,
} from '../../src/render/remotion-supervisor';

describe('render artifact lifecycle boundary', () => {
  it('post-processes and records only after worker cleanup succeeds', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'render-lifecycle-'));
    const rawOutput = path.join(root, 'raw.mp4');
    const outputLocation = path.join(root, 'preview.mp4');
    await writeFile(rawOutput, 'raw');
    const calls: string[] = [];
    await finalizeRawRender(
      {
        projectPath: root,
        target: 'preview',
        rawOutput,
        outputLocation,
        fingerprint: 'fingerprint',
        workerRequest: {} as never,
      },
      {
        supervise: async () => { calls.push('worker'); },
        runFfmpeg: async () => {
          calls.push('post-process');
          return {command: 'ffmpeg', args: [], stdout: '', stderr: '', exitCode: 0};
        },
        recordArtifact: async () => { calls.push('record'); },
      },
    );
    expect(calls).toEqual(['worker', 'post-process', 'record']);
  });

  it('does not post-process or record after cleanup failure', async () => {
    const postProcess = vi.fn();
    const recordArtifact = vi.fn();
    await expect(
      finalizeRawRender(
        {
          projectPath: '/project',
          target: 'master',
          rawOutput: '/project/work/render/master-remotion.mov',
          outputLocation: '/project/output/master.mov',
          fingerprint: 'fingerprint',
          workerRequest: {} as never,
        },
        {
          supervise: async () => { throw new Error('process group 4102 did not exit'); },
          runFfmpeg: postProcess,
          recordArtifact,
        },
      ),
    ).rejects.toThrow(/4102/);
    expect(postProcess).not.toHaveBeenCalled();
    expect(recordArtifact).not.toHaveBeenCalled();
  });

  it('maps render interruptions to conventional exit codes', () => {
    expect(exitCodeForRenderError(new RenderInterruptedError('SIGINT'))).toBe(130);
    expect(exitCodeForRenderError(new RenderInterruptedError('SIGTERM'))).toBe(143);
    expect(exitCodeForRenderError(new Error('render failed'))).toBe(1);
  });
});
```

Supervisor-specific tests must inject the worker entrypoint and short cleanup durations, assert request/result temporary files are removed, verify stderr from the worker is retained in an error, and assert `stopOwnedProcessGroup()` receives only the spawned PGID.

- [ ] **Step 2: Run the supervisor tests and verify RED**

Run: `npx vitest run tests/unit/remotion-supervisor.test.ts`

Expected: FAIL because the supervisor, interruption error, exit-code mapper, and artifact sequencing helper do not exist.

- [ ] **Step 3: Implement supervised worker execution**

Use this production contract:

```ts
export const DEFAULT_GRACEFUL_CANCEL_MS = 10_000;

export class RenderInterruptedError extends Error {
  readonly exitCode: number;

  constructor(readonly signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP') {
    super(`Render interrupted by ${signal}`);
    this.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
  }
}

export const exitCodeForRenderError = (error: unknown): number =>
  error instanceof RenderInterruptedError ? error.exitCode : 1;

export type RemotionSupervisorOptions = {
  workerEntryPoint?: string;
  gracefulCancelMs?: number;
  cleanupTimeouts?: Partial<CleanupTimeouts>;
  signalTarget?: Pick<NodeJS.Process, 'on' | 'off'>;
  onWorkerSpawn?: (pid: number) => void;
};
```

`superviseRemotionRender()` must atomically write one request file under the target's existing `work/render` directory, include supervisor-owned browser-launcher and browser-PGID sidecar paths, start `node --import tsx src/render/remotion-worker.ts <request> <result>` with `spawnOwnedProcess()`, mirror and capture worker stdout/stderr, and install parent `SIGINT`, `SIGTERM`, and `SIGHUP` listeners across the spawn/cleanup boundary.

On the first parent signal, record it and forward graceful `SIGTERM` to the live worker so Task 2 can cancel Remotion and close Chrome without triggering Remotion's immediate-exit `SIGINT` handler. Retain the original parent signal for the final conventional exit status. Race worker exit against the 10-second graceful deadline. Structurally guarantee cleanup after every successful spawn: disable further PID forwarding, quiesce and verify the worker PGID once, read the browser sidecar, then verify its exact PGID once. Always remove parent listeners and unlink request, result, launcher, and PGID files.

If both rendering and group cleanup fail, throw `AggregateError([renderError, ...cleanupErrors], 'Remotion render and owned-process cleanup both failed')`. Preserve a nested `RenderInterruptedError` when mapping the CLI status. If a signal was received and cleanup completed, throw `RenderInterruptedError` after reading the worker result. Never search or signal by executable name.

- [ ] **Step 4: Integrate the artifact boundary**

In `src/render/remotion.ts`, delete the in-process `bundle()`, `selectComposition()`, `renderMedia()`, and module-level bundle promise. Keep validation, readiness, fingerprinting, `prepareRenderProps()`, `readRenderSettings()`, output paths, Rec.709 post-processing, delivery encoding, and artifact registration.

Build a request containing the staged input props and parsed settings, then call a focused helper with this sequence:

```ts
await dependencies.supervise(input.workerRequest);
await dependencies.runFfmpeg(postProcessArgs(input.target, input.rawOutput, input.outputLocation));
await dependencies.recordArtifact(
  input.projectPath,
  input.target,
  input.outputLocation,
  input.fingerprint,
);
```

Export `finalizeRawRender()` for focused lifecycle tests. Keep `renderPreview()` and `renderMasterAndDelivery()` return values unchanged.

In `src/cli.ts`, replace the unconditional `process.exitCode = 1` in the top-level catch with `process.exitCode = exitCodeForRenderError(error)` while retaining the existing error text.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/process-group.test.ts tests/unit/remotion-worker.test.ts tests/unit/remotion-supervisor.test.ts`

Expected: PASS with exact call order, signal exit codes, and owned-group cleanup.

- [ ] **Step 6: Run render-policy and artifact regressions**

Run: `npx vitest run tests/unit/render-policy.test.ts tests/unit/render-artifacts.test.ts tests/unit/edit-approval.test.ts tests/integration/edit-validation.test.ts`

Expected: PASS with existing render gates and fingerprints unchanged except for the intentional pipeline-source fingerprint change.

- [ ] **Step 7: Run type checking**

Run: `npm run typecheck`

Expected: PASS with no diagnostics.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/render/remotion-supervisor.ts src/render/remotion.ts src/cli.ts tests/unit/remotion-supervisor.test.ts
git commit -m "fix: supervise Remotion process cleanup"
```

---

### Task 4: Real macOS Success and Forced-Cancellation Validation

**Files:**
- Modify: `scripts/synthetic-e2e.ts`
- Create: `tests/fixtures/run-remotion-request.ts`
- Create: `tests/helpers/remotion-process-inventory.ts`
- Create: `tests/e2e/remotion-cleanup.test.ts`

**Interfaces:**
- Consumes: `prepareRenderProps()`, `readRenderSettings()`, `superviseRemotionRender()`, and the existing synthetic reel assets/workflow.
- Produces: `prepareSyntheticReel()`, a signalable supervisor fixture, read-only baseline inventory, and a macOS lifecycle acceptance test.

- [ ] **Step 1: Write the macOS lifecycle acceptance test**

The inventory helper must run `ps -ax -o pid=,ppid=,pgid=,stat=,etime=,command=`, parse rows, and return only commands rooted in the current `engineRoot` or the worker's Remotion temporary profile. It is read-only and exposes no signal function.

Write an e2e test that snapshots PIDs before a successful synthetic render, checks that the after-minus-before set is empty, then prepares signalable synthetic preview requests. For both `SIGINT` and `SIGTERM`, launch the fixture, wait for `REMOTION_WORKER_STARTED`, require a Chrome process whose PPID ancestry reaches that exact worker through its owned launcher, send the signal to the fixture, and again check that no new Remotion-related PID remains. A pre-existing or concurrent Chrome process must not satisfy the active-browser condition.

```ts
const baseline = await listRemotionProcessInventory(repositoryRoot);
await runSyntheticE2e(repositoryRoot, {silent: true});
const afterSuccess = await listRemotionProcessInventory(repositoryRoot);
expect(newPids(baseline, afterSuccess)).toEqual([]);

const prepared = await prepareSyntheticReel(repositoryRoot, {silent: true});
const {props} = await prepareRenderProps(prepared.projectPath, repositoryRoot, 'preview');
const settings = await readRenderSettings(prepared.projectPath);
const requestPath = path.join(prepared.projectPath, 'work/render/cancel-request.json');
await writeJson(requestPath, {
  schemaVersion: '1.0.0',
  engineRoot: repositoryRoot,
  target: 'preview',
  rawOutput: path.join(prepared.projectPath, 'work/render/cancel-preview.mp4'),
  inputProps: props,
  settings,
});
const runner = spawn(process.execPath, [
  '--import',
  'tsx',
  path.join(repositoryRoot, 'tests/fixtures/run-remotion-request.ts'),
  requestPath,
], {cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe']});
await waitForOutput(runner.stdout, 'REMOTION_WORKER_STARTED');
runner.kill('SIGTERM');
const result = await waitForClose(runner);
expect(result).toEqual({exitCode: 143, signal: null});
const afterCancellation = await listRemotionProcessInventory(repositoryRoot);
expect(newPids(baseline, afterCancellation)).toEqual([]);
```

Use condition-based output waiting with a 120-second timeout; do not use an arbitrary sleep. Gate this test with `describe.runIf(process.platform === 'darwin')` and give the complete test 300 seconds.

- [ ] **Step 2: Run the lifecycle e2e test and verify RED**

Run: `npx vitest run tests/e2e/remotion-cleanup.test.ts --testTimeout=300000`

Expected: FAIL because synthetic preparation, inventory, and the signalable fixture are not implemented.

- [ ] **Step 3: Extract reusable synthetic preparation and add the fixtures**

Move only the setup portion of `runSyntheticE2e()` into `prepareSyntheticReel(engineRoot, options)`. The helper must return a fully analyzed, preview-ready project with its edit and rights record written, plus the project path, original file paths/hashes, and source IDs needed by the existing function. It must not render or record an approval. Keep the current two synthetic acceptance variants, edit contents, approvals, QC, immutable-input check, and artifact-reuse check byte-for-byte equivalent in behavior.

The signalable fixture must read and validate the request, call `superviseRemotionRender()` with an `onWorkerSpawn` callback that prints `REMOTION_WORKER_STARTED <pid>`, map `RenderInterruptedError` through `exitCodeForRenderError()`, and set `process.exitCode` without calling `process.exit()`.

The inventory helper must compare by PID and include state/elapsed time in assertion messages. It may identify repository-owned Remotion commands for observation, but it must never export or call `process.kill()`.

- [ ] **Step 4: Run the lifecycle e2e test and verify GREEN**

Run: `npx vitest run tests/e2e/remotion-cleanup.test.ts --testTimeout=300000`

Expected: PASS. The five pre-existing PID-1 `UE` processes may remain in both snapshots, but no new PID may remain after success, `SIGINT`, or `SIGTERM` cancellation.

- [ ] **Step 5: Run the complete repository verification**

Run: `npm run verify`

Expected: PASS for typecheck, unit/integration tests, existing synthetic e2e tests, lifecycle e2e tests, and reel doctor. If a pre-existing kernel-I/O stall blocks a command, record the exact command, timeout, PID/state evidence, and a focused rerun; do not weaken or skip the lifecycle assertions.

- [ ] **Step 6: Inspect the final diff and process baseline**

Run: `git diff --check origin/main...HEAD`

Run: `git status --short`

Run: `pgrep -fl "remotion|ffprobe|chrome-headless-shell|@remotion"`

Expected: no whitespace errors; only intentional tracked files plus the pre-existing untracked `.idea/`; process inventory contains no new repository-owned Remotion PID beyond the recorded baseline.

- [ ] **Step 7: Commit Task 4**

```bash
git add scripts/synthetic-e2e.ts tests/fixtures/run-remotion-request.ts tests/helpers/remotion-process-inventory.ts tests/e2e/remotion-cleanup.test.ts
git commit -m "test: validate Remotion lifecycle cleanup"
```

---

### Task 5: Final Review and Ready-to-Review Pull Request

**Files:**
- Verify: every file listed in the File Map
- Preserve: `.idea/` as untracked and unstaged

**Interfaces:**
- Consumes: all completed tasks and verification evidence.
- Produces: a pushed `rafal/remotion-process-cleanup` branch and a non-draft pull request targeting `main`.

- [ ] **Step 1: Review requirements against the approved design**

Confirm each acceptance criterion has direct code and fresh test evidence: exact ownership, explicit browser close, graceful cancellation, `SIGTERM`/`SIGKILL` escalation, unrelated-process survival, artifact registration after cleanup, kernel-state diagnostics, successful render inventory, and forced-cancellation inventory.

- [ ] **Step 2: Run final verification from a clean index**

Run: `npm run verify`

Run: `git diff --check origin/main...HEAD`

Run: `git status --short --branch`

Expected: verification exits 0; diff check exits 0; only `.idea/` is untracked and no implementation file is unstaged.

- [ ] **Step 3: Commit any final review-only correction**

If review required a correction, rerun its focused red/green test and commit only the correction files with a message describing the behavior. If no correction was required, do not create an empty commit.

- [ ] **Step 4: Push the feature branch**

Run: `git push -u origin rafal/remotion-process-cleanup`

Expected: the remote branch is created or updated successfully.

- [ ] **Step 5: Open a non-draft pull request**

Create a pull request targeting `main` with title `Fix Remotion process lifecycle cleanup`. The body must summarize ownership-scoped cleanup, explicit browser/cancellation handling, artifact gating, the existing `UE` baseline limitation, focused test results, real macOS success/cancellation validation, and full `npm run verify` evidence. Do not mark the pull request as draft.

- [ ] **Step 6: Verify the pull request**

Confirm the PR base is `main`, head is `rafal/remotion-process-cleanup`, draft state is false, the diff contains no `.idea/` content, and all expected commits are present. Return the PR URL and verification summary.
