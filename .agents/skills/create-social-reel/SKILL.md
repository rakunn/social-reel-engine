---
name: create-social-reel
description: Orchestrate local social-reel creation, editing, grading, previewing, rendering, and QC with the repository's FFmpeg, Remotion, and librosa engine. Use for MP4/MOV footage, DJI D-Log M, Sony S-Log3, technical or creative LUTs, music, captions, stabilization, vertical crops, approval-gated renders, or social-video QC.
---

# Create Social Reel

Create one isolated `projects/<reel-name>` job and drive it through the engine's checksum-bound workflow. Keep the user in control of editorial and color choices, preserve every original, and never infer a technical color transform.

## Non-negotiable rules

1. Work from the repository root and use `npm run reel -- <command> <reel-name>`. Do not reproduce engine scripts inside this skill.
2. Copy inputs with `ingest`; never alter or overwrite originals.
3. Treat camera model, gamma, gamut, LUT kind, LUT input/output spaces, and combined-transform semantics as facts that require user confirmation or reliable supplied metadata. Filename appearance and visual appearance are not confirmation.
4. Allow an unconfirmed source only in the visibly watermarked rough preview. Do not run `grade-stills`, `approve-color`, `grade`, or `render` until every selected source has an explicitly confirmed profile and exactly one matching technical or combined transform.
5. A combined normalization-and-look LUT replaces both the technical and creative stages. Never double-normalize or stack creative LUTs.
6. Never run either approval command on the user's behalf merely because an artifact looks plausible. Approval means the user reviewed the exact current artifact and explicitly accepted it.
7. Always stop twice:
   - after presenting the current rough-cut preview, before `approve-edit`;
   - after presenting the current graded reference frames, before `approve-color`.
8. If a timeline, crop, playback, transition, title, audio, caption, stabilization, grade, LUT, or blend changes, regenerate the affected review artifact and obtain the approval again.
9. Do not mark `rightsConfirmed` true. Only the user may confirm rights for footage, music, captions, LUTs, fonts, brand assets, and other supplied material.

## Load the focused guidance

- Read [inputs.md](references/inputs.md) before creating or ingesting a job.
- Read [color-safety.md](references/color-safety.md) whenever footage is log/HLG/HDR, a LUT is present, or the profile is uncertain.
- Read [editing.md](references/editing.md) before authoring or changing `edits/edit.json`.
- Read [approvals.md](references/approvals.md) before any preview, approval, grading, or rerender decision.
- Read [qc.md](references/qc.md) before final rendering or reporting completion.

## Workflow

### 1. Preflight and create the job

Run `npm run reel -- doctor`. Resolve a safe kebab-case reel name, then create the job with `npm run reel -- new <reel-name> --title "<title>"`.

Inventory every supplied file and the user's stated facts. Ingest each asset into its typed destination. Use the local LUT catalog only when its declared camera/profile and semantics match the user's confirmation. Record confirmations in `config/sources.json` and LUT declarations in `config/luts.json`; run `analyze` again after either changes.

If footage profile or transform semantics remain ambiguous, proceed only to a watermarked viewing proxy and clearly name the missing fact. Do not resolve ambiguity by selecting the LUT whose name seems closest.

### 2. Analyze and author the rough cut

Run `analyze`, `proxy`, and, when one music file is supplied, `beats`. Inspect the ffprobe metadata, contact sheets, representative frames, proxy watermark state, and beat/onset report. Author `edits/edit.json` from verified source IDs and follow [editing.md](references/editing.md).

Run `validate-edit`, then `preview` and `qc --target preview`. Inspect the rendered preview itself. Report the exact shot order, duration, crops, speed changes, transitions, titles, caption state, music/camera-audio choices, stabilization choices, warnings, and any unsafe unknowns.

**STOP — rough-cut approval.** Present a clickable absolute path to `previews/preview.mp4` and ask the user to approve this exact rough cut or request changes. End the task without running `approve-edit`. If anything changes, rerender and stop here again.

### 3. Build and present the grade

Only after the user explicitly approves the displayed rough cut, run `approve-edit`. Confirm the color chain for every selected shot. When a creative look was not specified, compare actual technically normalized reference frames; do not rank looks from filenames. Keep the neutral/no-creative-LUT treatment available.

Set exposure, white balance, and tint before the exact normalizer; set one optional creative LUT and its explicit per-shot blend after normalization. Run `grade-stills`. Inspect the generated PNGs for clipping, casts, skin/neutral balance where relevant, shot matching, and the intended restraint.

**STOP — color approval.** Present clickable absolute paths to the current files in `previews/graded-stills/`, state the technical/combined transform and creative blend used for each shot, and ask the user to approve this exact grade or request changes. End the task without running `approve-color`. If anything changes, regenerate the stills and stop here again.

### 4. Grade, render, and verify

Only after explicit approval of the displayed reference frames, run `approve-color`. Confirm the user has set `rightsConfirmed` true; if not, stop and request that confirmation.

Run `grade` and inspect `analysis/graded-clips.json`. Any stabilization fallback must match the per-shot fallback decision approved with the rough cut; otherwise stop and return to editorial approval. Then run `render`, followed by QC for `master` and `delivery` and finally `status`.

Do not claim completion when QC has a failure, a render fingerprint is stale, an output is unreadable, or a warning has not been reviewed. Deliver absolute paths to the ProRes master, H.264 delivery, and both human-readable QC reports, plus a concise note about warnings and stabilization outcomes.

## Resume an existing job

Start with `status`, inspect the current manifests and approval hashes, and continue from the reported checkpoint. Existing files are not proof of freshness. After any change, use [approvals.md](references/approvals.md) to determine which review must be repeated.
