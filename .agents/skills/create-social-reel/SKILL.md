---
name: create-social-reel
description: Use when creating, editing, grading, previewing, rendering, or validating local social reels and 1.91:1 video carousel packages with the repository's FFmpeg, Remotion, and librosa engine, including MP4/MOV footage, DJI D-Log M, Sony S-Log3, log or HDR profiles, technical or creative LUTs, music, captions, stabilization, approval-gated renders, and social-video QC.
---

# Create Social Reel

Create one isolated `projects/<reel-name>` job and drive it through the engine's checksum-bound reel or carousel workflow. Keep the user in control of editorial and color choices, preserve every original, and never infer a technical color transform.

## Autonomous interaction contract

Treat this skill as the complete orchestration workflow for routine reel production.

1. At intake, consolidate every currently knowable blocker into one request: missing source/profile or LUT facts, rights for the known asset set, and editorial requirements that materially change the result. State reasonable defaults for non-blocking creative choices and proceed when the user has delegated judgment.
2. Do not ask the user to approve a design document or implementation plan, or to choose an agent strategy, execution mode, checkout, worktree, branch, or commit workflow. Make those internal decisions autonomously and safely.
3. Do not split optional creative choices into serial questions. Choose a defensible treatment from the brief, explain it with the review artifact, and use artifact approval as the feedback point.
4. Classify intake as `ready` when every mandatory fact is resolved or `proxy-only` when a disclosed source-profile or transform fact remains unresolved. The ready path stops only at the rough-cut and color gates below. The proxy-only path may revisit only its named facts with the rough review; if resolving them changes the source confirmation or normalization, regenerate the preview and obtain rough approval again before color work. A later user-requested change may likewise invalidate an approval or introduce a genuinely new blocker.
5. Do not invoke `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:executing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`, or `superpowers:finishing-a-development-branch` for routine reel production. After a concrete technical failure, use `superpowers:systematic-debugging` internally when useful without adding approval gates. If the user requests changes to the reel engine or other repository source code, use the normal development workflow instead.

## Non-negotiable rules

1. Work from the repository root and use `npm run reel -- <command> <reel-name>`. Do not reproduce engine scripts inside this skill.
2. Copy inputs with `ingest`; never alter or overwrite originals.
3. Treat camera model, gamma, gamut, LUT kind, LUT input/output spaces, and combined-transform semantics as facts that require user confirmation or reliable supplied metadata. Filename appearance and visual appearance are not confirmation.
4. Allow an unconfirmed source only in the visibly watermarked rough preview. Do not run `grade-stills`, `approve-color`, `grade`, or `render` until every selected source has an explicitly confirmed profile and exactly one matching technical or combined transform.
5. A combined normalization-and-look LUT replaces both the technical and creative stages. Never double-normalize or stack creative LUTs.
6. Never run an approval command on the user's behalf merely because an artifact looks plausible. Approval means the user reviewed the exact current artifact and explicitly accepted it.
7. Use these mandatory artifact gates:
   - after presenting the current rough-cut preview, before `approve-edit`;
   - after presenting the current graded reference frames, before `approve-color`.
8. Regenerate and reapprove the rough after any editorial change. Regenerate and reapprove color only after a color-relevant change: source selection or interval, crop, stabilization, output color dimensions, exposure, white balance, tint, normalization/creative LUT selection or declaration, LUT bytes, treatment, or blend. Text, title, typography/style presets, audio, music, captions, and transitions do not by themselves invalidate an exact current color review; trust `status` rather than guessing.
9. Never infer rights or edit the rights fields manually. Only after the user explicitly confirms the exact current used footage, music, captions, LUTs, fonts, brand assets, and other material, run `confirm-rights`; it writes `rightsConfirmed` and binds the decision to the used-asset checksum fingerprint in `brief.json`. Trust `status`: a changed referenced asset makes the decision stale, while an unused newly ingested asset does not. Request only the missing confirmation, then rerun `confirm-rights` for the expanded used set.
10. Keep every runtime `projects/<reel-name>` job local-only. The entire `projects/**` tree is ignored except `projects/.gitkeep`; never stage or force-add a job's briefs, configuration, edit manifests, approvals, analysis, QC, media, or renders. Reusable engine defaults belong in `templates/reel/`.
11. Treat subject visibility and composition as shot-level invariants. Before authoring each selected shot, name the primary subject and required count, state whether centering is natural or an intentional off-center composition is preferred, choose `establish-and-hold` or a specifically justified intentional track, and define a safe margin. Center only when it improves the natural composition; never continuously chase a subject toward center. A rough cut is not ready for approval when a required subject leaves frame, a required group loses members, or crop translation feels forced.

## Load the focused guidance

- Read [inputs.md](references/inputs.md) before creating or ingesting a job.
- Read [color-safety.md](references/color-safety.md) whenever footage is log/HLG/HDR, a LUT is present, or the profile is uncertain.
- Read [editing.md](references/editing.md) before authoring or changing `edits/edit.json`.
- Read [approvals.md](references/approvals.md) before any preview, approval, grading, or rerender decision.
- Read [qc.md](references/qc.md) before final rendering or reporting completion.

## Workflow

### 1. Preflight and create the job

Run `npm run reel -- doctor`. Its `dependency-materialization` and `remotion-runtime` checks must pass before an expensive preview or final render, and a failing `storage-capacity` check must be resolved; these are technical preflights, not additional user approval gates. Treat a storage warning as a concrete capacity risk when planning repeated ProRes renders. Resolve a safe kebab-case reel name. Create a vertical reel with `npm run reel -- new <reel-name> --title "<title>"`; create an ordered landscape video carousel with `npm run reel -- new <reel-name> --title "<title>" --format carousel-1.91:1`.

When the request is a separate derivative of an existing project—such as clean and captioned versions—run `status` on the source and use `npm run reel -- variant <source-name> <target-name> --title "<title>"` instead of `new`. The variant is isolated and never copies the source preview, final outputs, or editorial approval. It inherits the exact edit decisions and corrections, validated proxy cache, checksum-bound rights, and color review only where their dependency hashes and reviewed bytes still match. Keep those approved corrections by default for the same sources/selections; do not generalize them to unrelated footage. If the user asks for an intentional visual departure, change the relevant values and follow the invalidation reported by `status`.

Inventory every supplied file and the user's stated facts. Ingest each asset into its typed destination. Use the local LUT catalog only when its declared camera/profile and semantics match the user's confirmation. Record confirmations in `config/sources.json` and LUT declarations in `config/luts.json`; run `analyze` again after either changes.

When the user requests styled copy, inspect the runtime source of truth with `npm run reel -- style --list`, apply a named preset with `npm run reel -- style <name> --apply <preset-id>`, then run `analyze` again because selected fonts are project inputs and rights assets. Preserve the source project's named preset for a derivative unless the user requests a new direction. When no competing direction is supplied for quiet Philippine scenic footage, recommend `philippines-island-editorial`; never choose raw font filenames or infer/transliterate Baybayin copy.

After the exact current used asset inventory is known, run `confirm-rights` if the user's explicit aggregate confirmation already covers it; otherwise keep rights in the consolidated intake request and run the command only after the user answers. Before long-running media work, ask once for all currently knowable missing profile, transform, rights, and material editorial facts. If footage profile or transform semantics remain ambiguous, declare the job proxy-only, name the exact missing facts and the first blocked command, and proceed only to a watermarked viewing proxy. Do not resolve ambiguity by selecting the LUT whose name seems closest.

### 2. Analyze and author the rough cut

Run `analyze`, `proxy`, and, when one music file is supplied, `beats`. Inspect the ffprobe metadata, contact sheets, representative frames, proxy watermark state, and beat/onset report. Author `edits/edit.json` from verified source IDs and follow [editing.md](references/editing.md).

Run `validate-edit`, then `preview` and `qc --target preview`. Inspect the rendered preview itself. Report the exact shot/card order, duration, crops, speed changes, transitions, titles, caption state, music/camera-audio choices, stabilization choices, chosen style preset and display/body/metadata role pairing, warnings, and any unsafe unknowns. In a carousel project, each ordered clip is one independently publishable card, every card must be 4–5 seconds, and the combined preview is the exact package-order review artifact; transitions and timeline-global music, titles, or captions are forbidden.

**STOP — rough-cut approval.** Present a clickable absolute path to `previews/preview.mp4` and ask the user to approve this exact rough cut or request changes. For a proxy-only job, include every previously disclosed unresolved source/profile or transform fact in this same response. End the task without running `approve-edit`.

If the user supplies those facts, record them, update the LUT declarations and edit as needed, rerun `analyze`, regenerate proxies, run `validate-edit`, regenerate the preview, and rerun preview QC. Source confirmation or normalization changes make the previous preview and approval stale, so present the normalized preview and stop for rough approval again. If the facts remain unavailable, keep the watermarked rough as a review artifact and do not run `grade-stills`.

### 3. Build and present the grade

Only after the user explicitly approves the displayed current rough cut and every fact required by `grade-stills` is resolved, run `approve-edit`. Confirm the color chain for every selected shot. When a creative look was not specified, compare actual technically normalized reference frames; do not rank looks from filenames. Keep the neutral/no-creative-LUT treatment available.

Set exposure, white balance, and tint before the exact normalizer; set one optional creative LUT and its explicit per-shot blend after normalization. Run `grade-stills`. Inspect the generated PNGs for clipping, casts, skin/neutral balance where relevant, shot matching, and the intended restraint. These PNGs intentionally isolate color; card-local typography and its contrast are reviewed in the rough preview.

**STOP — color approval.** Present clickable absolute paths to the current files in `previews/graded-stills/`, state the technical/combined transform and creative blend used for each shot, and ask the user to approve this exact grade or request changes. End the task without running `approve-color`. If anything changes, regenerate the stills and stop here again.

### 4. Grade, render, and verify

Only after explicit approval of newly displayed reference frames, run `approve-color`, then `status`. For an exact derivative, do not repeat `approve-color` when `status` confirms that the inherited color review remains current after the new rough is approved. Do not ask about rights again when status shows that the user's checksum-bound confirmation remains current. If status reports `awaiting-rights-confirmation`, run `confirm-rights` immediately when an explicit user statement already covers the exact current used set; otherwise stop and request only the missing confirmation, then run `confirm-rights` after the user answers.

Run `grade` and inspect `analysis/graded-clips.json`. Any stabilization fallback must match the per-shot fallback decision approved with the rough cut; otherwise stop and return to editorial approval.

For a vertical reel, run `render`, wait for it to exit and release the media operation, run QC for `master` to completion, run QC for `delivery` to completion, and finally run `status`. Never parallelize render or either QC command.

For a carousel project, run `render-carousel`, wait for every ordered MP4 card to finish and release the media operation, then run `qc-carousel` to completion and finally run `status`. Inspect `analysis/qc-carousel.md`, the fingerprinted source files recorded in `analysis/carousel.json`, and the user-facing files recorded in `analysis/carousel-share.json`. A failure-free QC run publishes the current cards together under `output/carousel/ready-to-share/`; failed QC removes any older share package so stale cards are not presented as current. Do not substitute the combined timeline delivery for the independently encoded card files, and do not run standard `render` or photo export for a carousel project.

If a vertical-reel prompt explicitly requests a photo package, continue only after both final QC reports are current and failure-free. Run `photos <reel> --aspect <profiles...> --count <count>`; omit the options only when an already configured requested package should be resumed. `9:16` stills reuse the approved moving crop and can publish automatically. For `4:5`, `1:1`, or `16:9`, present clickable absolute paths to every contact sheet under `previews/photo-candidates/`, state that each is an anchored proposed reframe, and **STOP — photo reframe approval.** Do not run `approve-photos` until the user explicitly approves the exact current candidate sheets. After approval, run `approve-photos`, rerun `photos`, and inspect `analysis/photo-qc.md`. Any edit, grade, crop, stabilization, source, LUT, requested profile, count, or final-render change makes photo output and non-9:16 reframe approval stale.

Do not claim completion when QC has a failure, a render/package fingerprint is stale, an output is unreadable, or a warning has not been reviewed. For a reel, deliver absolute paths to the ProRes master, H.264 delivery, and both human-readable QC reports. For a carousel, deliver a clickable absolute path to `output/carousel/ready-to-share/`, the ordered absolute MP4 paths from `analysis/carousel-share.json`, and `analysis/qc-carousel.md`; treat the fingerprinted files in `analysis/carousel.json` as the canonical validation source rather than the primary user handoff. In both cases include a concise note about warnings and stabilization outcomes. When requested for a reel, also deliver final `output/photos/<profile>/` files and `analysis/photo-qc.md`.

## Active media work and recovery

When `analysis/operation.json` records a live media command, `status` is safe to run: it returns the recorded command, phase, and progress before any input checksum scan. Use that snapshot and low-impact PID observation for ETA. Do not run `analyze`, `proxy`, or any other media producer concurrently with the recorded job.

External media commands are process-group owned and bounded: FFmpeg is stopped after a prolonged period without output, while probes and preflight commands have wall-clock limits. Do not start an ad hoc duplicate or kill processes by command name when a job is merely quiet; let the tracked command return, then follow `status`.

If `status` reports `interrupted-media-job`, do not manually trust, copy, delete, or register partial media/artifact files. Rerun the exact command named by `status`; durable outputs are atomically published only after validation, disposable render staging is rebuilt automatically, and a successful retry replaces the stale operation record. This recovery does not bypass any rights or approval gate.

## Resume an existing job

Start with `status`, inspect the current manifests and approval hashes, and continue from the reported checkpoint. If it reports `media-in-progress`, wait rather than starting another media command; if it reports `interrupted-media-job`, rerun its exact retry command. Existing files and a bare `rightsConfirmed: true` are not proof of freshness; a legacy Boolean without its used-asset fingerprint cannot authorize final export. After any change, use [approvals.md](references/approvals.md) to determine which review must be repeated.
