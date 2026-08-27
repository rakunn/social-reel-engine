# Reel Derivative Variants Specification

## Goal

Make non-color derivatives such as captioned carousel packages fast and safe while preserving beneficial approved corrections and keeping the clean source project untouched.

## Required behavior

1. `reel variant <source> <target>` creates a new isolated project from an existing project.
2. The target receives immutable copy-on-write copies of inputs, confirmed source facts, LUT declarations, settings, edit decisions, analysis manifests, proxies, contact sheets, graded intermediates, and current rights confirmation.
3. The target gets its own identity, output directories, preview, approvals, operation state, and final package. Existing source outputs are never overwritten.
4. Variant creation rejects a missing source, unsafe names, an existing target, active media work, symlinks in copied project material, and checksum mismatches.
5. The copied edit is renamed to the target project while retaining shot order, trims, crops, stabilization, audio, text overlays, exposure, white balance, tint, LUT choices, blends, and treatments.
6. Technical normalization remains mandatory for a confirmed log profile. Approved shot corrections are inherited by default for byte-identical source selections. They are not generalized to unrelated footage.
7. Editorial approval is tied to the exact preview. Color approval is tied to a color-relevant projection and reviewed graded stills, not text, audio, titles, music, or transitions.
8. A text-only variant requires a new rough preview approval. Existing color approval may remain current only when the color projection and reviewed still checksums are unchanged.
9. Card-local text remains isolated to its carousel card and passes safe-area/length validation.
10. Graded reference stills intentionally isolate color. Card-text typography and contrast are reviewed in the exact rough preview, keeping text-only edits independent from color approval.
11. The skill routes derivative requests through `variant`, preserves approved corrections, and asks for no additional prompt wording beyond desired changes.

## Non-goals

- Do not auto-grade unrelated footage.
- Do not apply one exposure or contrast value to every D-Log M clip.
- Do not create a shared mutable media store.
- Do not carry final output packages into a new variant.
- Do not bypass checksum-bound rights, rough-cut, or genuinely color-relevant approvals.

## Verification

- TypeScript typecheck.
- Unit tests for variant isolation, copy integrity, approval projections, and card-text validation.
- Integration tests for copied proxy reuse and exact-match approval reuse.
- Full unit and integration suites plus doctor.
- Skill validation and a realistic derivative-workflow behavior check.
