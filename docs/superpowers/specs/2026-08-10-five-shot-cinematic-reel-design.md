# Five-Shot Cinematic Reel Design

## Objective

Create a 12–13 second, 9:16 cinematic reel from the five supplied DJI clips. Every source must appear once, using only its strongest visual moment. The reel has no music, camera audio, titles, or captions.

## Source facts and safety constraints

- Inputs: five immutable source clips supplied from `/Volumes/T7 Shield/content/2026 Filipiny/statek/04.16/`.
- Reliable embedded metadata identifies the camera as DJI Mini 4 Pro.
- Each primary video stream is 3840×2160 HEVC Main 10 at 60000/1001 fps with no audio stream.
- Recorded gamma and gamut are not yet confirmed. Container BT.709 tags are not sufficient evidence of the camera recording profile.
- Until gamma and gamut are confirmed, the rough preview must remain visibly watermarked as an unnormalized viewing proxy. No technical LUT, graded still, color approval, grade, or final render may be produced.
- Originals remain untouched; project inputs are checksum-verified copies created by the reel engine's ingest command.

## Editorial design

The reel uses a five-shot visual crescendo. Each source contributes one approximately 2–3 second selection, with the total edit targeting 12–13 seconds. The final shot order is chosen after visual analysis to build progression through motion, scale, direction, and visual impact rather than preserving capture order.

Selections prioritize a clean action, readable subject, safe horizon, and strong entrance or exit motion. The edit may use 0.5× playback selectively where the 59.94 fps source produces natural 29.97 fps slow motion; otherwise footage remains at natural speed. No synthetic frames are introduced.

Cuts are predominantly direct and motion-matched. One restrained dissolve may be used only if it materially improves the midpoint or closing transition. The design excludes flashy effects and repeated footage.

## Framing and stabilization

Each landscape source receives a subject-aware 9:16 crop. Crop positions may animate between explicit start and end points to preserve the subject and horizon throughout the shot. Important content must remain inside platform-safe areas.

Stabilization is enabled only for a shot with visibly distracting motion after proxy inspection. Any enabled stabilization uses `fallbackToUnstabilized: false`; a failed stabilization must stop the workflow for review rather than silently changing the approved framing.

## Audio and graphics

The output is intentionally silent. The sources contain no audio streams, and the user requested no music. The edit contains no titles, captions, CTA, logos, or other graphic overlays.

## Review and validation

The project follows the repository's checksum-bound workflow: create, ingest, analyze, proxy, author the edit, validate, preview, and preview QC. The exact rendered rough preview must be inspected for crop tracking, horizon safety, motion continuity, transition restraint, black or frozen sections, and the visible unconfirmed-profile watermark.

The user must explicitly approve that exact rough-cut artifact before `approve-edit` can run. Any later change to timing, shot order, crop, speed, transition, graphics, audio, or stabilization invalidates editorial approval and requires a new preview.

Color work remains a separate approval gate. Before graded reference frames can be generated, the user must confirm the recorded gamma and gamut for all five clips and the workflow must install exactly one matching declared technical or combined transform. Final rendering additionally requires explicit user confirmation of usage rights for all supplied material.

## Acceptance criteria for the rough cut

- Duration is between 12 and 13 seconds.
- All five source clips appear exactly once at their strongest selected moment.
- The composition is 9:16 and each animated crop keeps its subject and horizon readable.
- Selective slow motion is frame-safe and visually natural.
- Transitions are mostly direct cuts, with no more than one restrained dissolve.
- The preview is intentionally silent and contains no text or captions.
- Preview validation and QC complete without an unreviewed failure.
- The unconfirmed camera gamma/gamut is clearly reported and visibly watermarked.
