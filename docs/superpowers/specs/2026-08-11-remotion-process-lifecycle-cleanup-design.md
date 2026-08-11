# Remotion Process Lifecycle Cleanup Design

## Objective

Ensure every Remotion render owns and cleans up the browser, compositor, probing, bundling, and encoding processes it starts on macOS. A render must not report success or register a fresh artifact until its owned Remotion process group has terminated. Cleanup must never target another render or a pre-existing process by executable name alone.

## Observed failure and root cause

The successful Filipiny reel run left four render descendants behind: two Remotion `ffprobe` processes, one native Remotion compositor, and one Chrome Headless Shell process. A later policy-verification run left another Chrome process. All five are reparented to PID 1 and currently have macOS state `UE`, meaning exit has already been requested but the kernel is still holding them in uninterruptible I/O. No userspace signal can force a process out of that state; the pipeline can prevent new unowned leftovers and report an incomplete kernel cleanup, but it cannot guarantee immediate removal of the existing five.

The repository currently calls `selectComposition()` and `renderMedia()` without an explicit browser instance or Remotion cancellation signal. In Remotion 4.0.507, several internal cleanup paths start browser, server, and page cleanup without awaiting completion. If the parent render command fails, is interrupted, or exits while macOS storage is slow, those descendants can outlive their owner and become PID-1 orphans.

## Scope and safety constraints

- Automatic cleanup applies only to processes created for the current render.
- The implementation must not scan for and terminate all processes whose command contains `remotion`, `ffprobe`, or Chrome.
- Concurrent renders must have independent ownership boundaries.
- The five existing `UE` processes are a diagnostic baseline. Validation must prove that the new pipeline adds no further stale processes; it must not attempt a global sweep of the baseline.
- Existing approval, fingerprint, color, rights, artifact, and output policies remain unchanged.
- A kernel-blocked owned process is a render-cleanup failure, even when media encoding produced a readable file.

## Architecture

### Render supervisor

The existing public render functions retain validation, readiness, fingerprint, post-processing, delivery encoding, and artifact-registration responsibilities. The Remotion-specific bundle, composition-selection, and raw-render phase moves behind a supervisor that starts one dedicated worker for each render target.

On macOS and other POSIX systems, the worker starts as the leader of a new process group. Remotion bundler, native compositor, `ffprobe`, and FFmpeg descendants that inherit the worker group are therefore addressable without matching process names. The supervisor records only the worker PID and derived process-group ID for that invocation.

The supervisor relays worker output, receives a structured success or failure result, and forwards parent interruption as a graceful cancellation request. Before returning, it verifies that the owned process group is empty. Cancellation gets 10 seconds to settle normally; if members remain, the supervisor sends `SIGTERM` and waits 5 seconds, then sends `SIGKILL` to that group only and verifies for a final 5 seconds. Tests may inject shorter durations without changing the production defaults.

### Remotion worker

The worker performs one raw preview or master render. It creates a Remotion cancellation signal and one explicit browser instance, passes that instance to both `selectComposition()` and `renderMedia()`, and passes the cancellation signal to `renderMedia()`.

`SIGINT`, `SIGTERM`, and `SIGHUP` handlers request cancellation without calling `process.exit()` immediately. The worker always awaits browser closure in `finally`, removes its signal handlers, and reports its result only after the explicit browser lifecycle has settled. This handles Chrome separately because Remotion launches Chrome as the leader of its own detached process group.

### Artifact boundary

The worker writes only the existing raw Remotion output. The supervisor performs the current Rec.709 metadata copy/post-processing after the worker and its owned processes have exited. `recordRenderArtifact()` runs only after process cleanup and post-processing both succeed. Failed or incomplete cleanup may leave a raw work file, but it must not create or refresh the approved preview, master, delivery, or artifact record.

## Data and control flow

1. Validate the edit and final-render gates exactly as today.
2. Return immediately when the existing artifact is already fresh.
3. Prepare render props and settings.
4. Start a dedicated Remotion worker and record its PID/process-group ID.
5. The worker bundles, opens one explicit browser, selects the composition, and renders the raw media.
6. On success, failure, or interruption, cancel active Remotion work and await explicit browser closure.
7. The supervisor verifies and, when necessary, terminates only the worker process group.
8. If cleanup is complete, post-process the raw output and register the artifact. Otherwise fail without registration.

## Error and interruption behavior

- Preserve the original render error and append cleanup diagnostics rather than replacing its cause.
- A user interrupt exits with the conventional signal-derived status only after cleanup has been attempted.
- Cleanup diagnostics include the owned process-group ID and any remaining member PIDs/states found through a read-only process-table query filtered by that exact group ID. Process names are diagnostic data only and never select signal targets.
- If macOS reports an owned member in uninterruptible I/O, the command explains that termination is pending in the kernel and fails cleanly. It does not claim that the process was removed.
- A cleanup failure never triggers a global process-name sweep and never targets the recorded baseline or an unrelated sentinel process.

## Test strategy

### Automated lifecycle tests

- A fixture worker that exits normally after spawning a child and grandchild leaves its process group empty.
- A fixture worker that throws after spawning descendants is cleaned up.
- A fixture worker interrupted with `SIGINT` or `SIGTERM` is cancelled and cleaned up.
- A stubborn interruptible child exercises the `SIGTERM` to `SIGKILL` escalation path.
- An unrelated sentinel process in a different process group remains alive through every cleanup case.
- Artifact registration is skipped when worker cleanup reports failure.
- Unit and integration tests use owned PIDs/process groups, not global executable-name matching.

### macOS validation

1. Record the five existing `UE` Remotion-related processes as the baseline.
2. Run a successful synthetic Remotion render and verify its recorded process group is empty.
3. Force-cancel an active synthetic render and verify its recorded process group is empty.
4. Compare the post-run Remotion process inventory with the baseline and verify that no new orphaned compositor, `ffprobe`, or Chrome process exists.
5. Run type checking, unit tests, integration tests, end-to-end tests, and the reel doctor. Report any environment-level limitation separately rather than weakening assertions.

## Acceptance criteria

- Normal completion, render failure, `SIGINT`, and `SIGTERM` leave no interruptible process owned by that render.
- Chrome closure is explicitly awaited, and native descendants are contained by the worker process group.
- Cleanup never terminates an unrelated concurrent render or sentinel process.
- A render artifact is registered only after lifecycle cleanup succeeds.
- A kernel-blocked owned process produces actionable PID/state diagnostics and a failed command, not a false success.
- The successful and forced-cancellation macOS validations add zero new stale Remotion-related processes beyond the recorded baseline.
- The repository verification suite passes, or any pre-existing environment failure is reproduced and reported with fresh evidence.
