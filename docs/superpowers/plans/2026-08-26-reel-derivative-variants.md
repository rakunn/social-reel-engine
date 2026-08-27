# Reel Derivative Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every behavior change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe derivative-project creation, preserve exact-match approved corrections, avoid redundant proxy work, and teach the reel skill to use the workflow.

**Architecture:** Add a project-level variant service that creates a fresh scaffold and copy-on-write clones only reusable inputs/configuration/cache artifacts. Split editorial and color dependency projections so non-color edits do not erase valid grade work, while keeping preview and reference checksums authoritative. Keep card text in the existing per-clip manifest and review it in the exact rough preview while graded stills isolate color.

**Tech Stack:** TypeScript 5.9, Node.js 24 filesystem APIs, Zod, FFmpeg, Remotion, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-reel-derivative-variants.md`

## Global Constraints

- Preserve all existing project inputs and outputs.
- Use `apply_patch` for repository edits.
- Do not commit unless the user requests a commit.
- Every production behavior begins with a failing real-behavior test.
- Runtime projects remain ignored and local-only.
- A derivative must never reuse stale or checksum-mismatched artifacts.

---

### Task 1: Safe derivative project service and CLI

**Files:**
- Create: `src/project/variant.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/registry.ts`
- Test: `tests/unit/project-variant.test.ts`
- Test: `tests/unit/command-surface.test.ts`

**Interfaces:**
- Produces: `createProjectVariant({engineRoot, sourceName, targetName, title?, now?})` returning source/target paths and reused artifact counts.

- [x] Write a failing test that creates a source project with inputs, source facts, LUTs, edit corrections, rights, and cached proxies, then asserts an isolated target preserves reusable bytes and decisions but omits previews, outputs, and media-operation state.
- [x] Run the focused test and verify it fails because the variant service and command do not exist.
- [x] Implement path validation, active-operation rejection, copy-on-write regular-file cloning, checksum verification, identity rewrite, and target-local approval/output reset.
- [x] Add `variant <source> <target> [--title]` to the stable command registry and CLI.
- [x] Run focused project/command tests until green.

### Task 2: Color-relevant approval projection

**Files:**
- Modify: `src/core/approvals.ts`
- Modify: `src/contracts/schemas.ts`
- Modify: `src/edit/approve.ts`
- Modify: `src/media/grade.ts`
- Test: `tests/unit/edit-approval.test.ts`
- Test: `tests/unit/color-policy.test.ts`

**Interfaces:**
- Produces: `createColorInputHash(edit, luts)` independent of text/audio/title/music/transition changes.
- Color projection includes clip ID, source ID, selection, crop, stabilization, grade, output color dimensions, and selected LUT definitions.

- [x] Write failing tests proving text/audio/title changes preserve the color-input hash while source interval, crop, stabilization, grade, or LUT changes invalidate it.
- [x] Run focused tests and verify the current full edit hash causes the expected failures.
- [x] Implement the color projection and update still/approval records to bind color review to it rather than the editorial review hash.
- [x] Keep final readiness dependent on both current edit approval and current color approval.
- [x] Add backwards-safe schema parsing for existing approval records; stale legacy records must not become valid accidentally.
- [x] Run approval and status tests until green.

### Task 3: Card-text review and validation

**Files:**
- Modify: `src/contracts/schemas.ts`
- Modify: `src/remotion/Reel.tsx`
- Test: `tests/unit/carousel.test.ts`

**Interfaces:**
- Consumes: per-clip `textOverlay`.
- Produces: validated safe card text in the exact rough-preview treatment without coupling typography to color approval.

- [x] Write failing tests for excessive card text, unsupported placement, neighboring-card isolation, and visible rough-preview overlay composition.
- [x] Run focused tests and confirm the failures identify missing validation/composition.
- [x] Add bounded style options, safe defaults, and validation messages without enabling carousel-global titles or captions.
- [x] Keep graded review stills text-free so text-only changes remain outside the color approval projection.
- [x] Run carousel and approval tests until green.

### Task 4: Variant cache and approval reuse

**Files:**
- Modify: `src/project/variant.ts`
- Modify: `src/media/proxy.ts`
- Modify: `src/edit/approve.ts`
- Test: `tests/integration/media-pipeline.test.ts`
- Test: `tests/unit/project-variant.test.ts`

**Interfaces:**
- Reuses only project-local copied artifacts whose existing fingerprint and file checksums remain valid in the target.

- [x] Write a failing integration test showing the first proxy call in a valid derivative reports cached reuse and a tampered copied proxy regenerates.
- [x] Run it and verify the derivative currently retranscodes or lacks the artifact record.
- [x] Copy only reusable proxy/contact-sheet/artifact records, preserving relative paths and verifying checksums after cloning.
- [x] Preserve rights when the exact used-asset fingerprint is unchanged.
- [x] Preserve color approval only when the new color-input hash and reviewed-still checksums are unchanged; always reset editorial approval for a derivative.
- [x] Run media and approval integration tests until green.

### Task 5: Skill derivative policy

**Files:**
- Modify: `.agents/skills/create-social-reel/SKILL.md`
- Modify: `.agents/skills/create-social-reel/references/inputs.md`
- Modify: `.agents/skills/create-social-reel/references/editing.md`
- Modify: `.agents/skills/create-social-reel/references/approvals.md`
- Modify: `.agents/skills/create-social-reel/references/color-safety.md`
- Test: `tests/skill-evals/cases.json`
- Test: `tests/skill-evals/forward.md`

**Interfaces:**
- Teaches future runs to choose `variant` for an approved derivative, inherit exact-match corrections, and request new decisions only when observable inputs change.

- [x] Run a baseline derivative scenario against the current skill and record whether it needlessly creates a fresh project, discards grade corrections, or repeats rights/color questions.
- [x] Add the smallest conditional derivative guidance supported by the engine behavior.
- [x] Add a realistic skill-eval case whose success criteria check variant use, correction inheritance, cache reuse, and approval boundaries.
- [x] Run a forward behavior check with the updated skill.
- [x] Validate the skill using the bundled `quick_validate.py`.

### Task 6: Full verification and prompt handoff

**Files:**
- Modify only files required by failures found in verification.

- [x] Run `npm run typecheck`.
- [x] Run unit and integration suites with process-table access where required.
- [x] Run `npm run reel -- doctor`.
- [x] Inspect the working-tree diff for unrelated or generated project files.
- [x] Report what future prompts may optionally specify: desired derivative, whether to preserve the approved look, caption language/text, and any intentional creative departure.
