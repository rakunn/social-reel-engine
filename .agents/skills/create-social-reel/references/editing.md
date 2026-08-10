# Editing policy

## Analyze before selecting

Run `analyze` and `proxy` for every job; run `beats` when music is present. Inspect representative frames, contact sheets, the full viewing proxies, durations, frame rates, rotation, and beat/onset timestamps before authoring the timeline.

## Author the edit manifest

Use `analysis/sources.json` IDs. For every ordered clip, set verified in/out seconds, a frame-safe playback rate, animated 9:16 crop start/end, explicit stabilization settings, grade settings, camera-audio gain/mute, and the following transition. Define titles, supplied music offset/gain, and imported caption path/format at the manifest level.

Target 20–30 seconds and normally aim near 25 seconds. Favor a clear opening hook, readable visual progression, and restrained transitions. Snap cuts to useful musical events only when that improves the scene; do not sacrifice narrative or motion continuity to hit every beat.

## Crop and playback safety

Use representative frames and the moving image to locate the subject and horizon. Do not blindly center-crop landscape footage. Keep important text and subjects within platform-safe areas and review the entire animated crop, not only endpoints.

Playback rates are limited to 0.5–2.0. Do not request a rate that needs synthetic frames at 30 fps; the engine intentionally does not provide optical-flow slow motion. Preserve natural motion and check source frame rate before slowing footage.

## Stabilization

Stabilization is per shot. Enable it only after observing unwanted motion. Record strength and `fallbackToUnstabilized` in the shot manifest so the choice is covered by editorial approval and artifact fingerprints.

Review crop/edge safety and softness. Prefer `fallbackToUnstabilized: false` unless the user explicitly accepts the original shot as a fallback. A changed stabilization setting requires a new rough-cut approval and color approval.

## Captions and audio

Verify whether caption timestamps refer to the final reel timeline. Review reading speed, overlap, truncation, contrast, and safe-area placement in the preview. Never rewrite or retime supplied captions without user authorization.

Treat beat detection as editorial assistance. Set music and camera-audio gains deliberately, listen to the preview, and confirm that camera audio should be used rather than assuming it. Final loudness normalization cannot repair poor creative mixing.

## Validate and review

Run `validate-edit` before every rough preview. Treat duration warnings, stabilization fallback choices, black/frozen diagnostic warnings, and ambiguous crop subjects as human-review items even when schema validation passes.
