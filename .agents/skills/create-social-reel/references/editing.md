# Editing policy

## Analyze before selecting

Run `analyze` and `proxy` for every job; run `beats` when music is present. Inspect representative frames, contact sheets, the full viewing proxies, durations, frame rates, rotation, and beat/onset timestamps before authoring the timeline.

## Author the edit manifest

Use `analysis/sources.json` IDs. For every ordered clip, set verified in/out seconds, a frame-safe playback rate, animated crop start/end for the project's output profile, explicit stabilization settings, grade settings, camera-audio gain/mute, and the following transition. Define titles, supplied music offset/gain, and imported caption path/format at the manifest level for vertical reels.

Target 20–30 seconds and normally aim near 25 seconds. Favor a clear opening hook, readable visual progression, and restrained transitions. Snap cuts to useful musical events only when that improves the scene; do not sacrifice narrative or motion continuity to hit every beat.

For a `carousel-1.91:1` project, each ordered clip is one standalone card and must last 4–5 seconds after playback-rate adjustment. Use at least two cards, set every `transitionAfter` to `none`, and leave timeline-global titles, music, and captions empty. The first card is the hero/hook; the final card must provide visual closure. The combined preview exists to review the exact card order, composition, and boundaries, while `render-carousel` publishes one MP4 per card.

## Subject and composition contract

Before writing each selected clip into `edits/edit.json`, record a shot contract in the editorial working notes:

- primary subject and required count, such as `boat / 1` or `huts / 3`;
- `mustRemainVisible` and a safe margin appropriate to the subject's motion;
- `center-if-natural` versus an intentional left/right/top/bottom bias;
- the initial subject anchor from the first stable moment;
- crop mode: `establish-and-hold` by default, or `intentional-track` with a concrete visual reason.

Subject preservation and subject tracking are different decisions. Center a subject when that makes the frame read better without damaging the scene. Otherwise preserve the shot's intentional bias. Establish the composition once at the first stable moment, hold it, and allow natural subject drift inside the safe margin. Use animated crop translation only when it prevents the required subject from leaving frame or expresses an intentional, slow visual move. Continuous recentering is a failure mode: do not chase a boat, person, or hut group toward the center just because it moves.

If a required subject or count cannot stay visible with a stable, natural crop, change the in/out interval, choose another source, widen the crop, or reject the shot. Do not repair a weak shot with aggressive keyframed translation.

## Crop and playback safety

Use representative frames and the moving image to locate the subject, subject count, and horizon. Do not blindly center-crop landscape footage. Keep important text and required subjects within platform-safe areas and review the entire animated crop at the first stable moment, 25%, 50%, 75%, and the final stable moment—not only the endpoints. Verify that a required group, such as three huts, remains a group and is not reduced to one visible member.

For each shot, compare the intended composition to the rendered project crop: 9:16 for reels or 1.91:1 for landscape carousel cards. A centered subject is a preference, not a universal target; preserve good off-center framing when it is visually stronger. Any crop motion must be slow, minimal, and visibly motivated by subject safety or narrative—not a continuous attempt to make the subject look locked to screen center.

Playback rates are limited to 0.5–2.0. Do not request a rate that needs synthetic frames at 30 fps; the engine intentionally does not provide optical-flow slow motion. Preserve natural motion and check source frame rate before slowing footage.

## Stabilization

Stabilization is per shot. Enable it only after observing unwanted motion. Record strength and `fallbackToUnstabilized` in the shot manifest so the choice is covered by editorial approval and artifact fingerprints.

Review crop/edge safety and softness. Prefer `fallbackToUnstabilized: false` unless the user explicitly accepts the original shot as a fallback. A changed stabilization setting requires a new rough-cut approval and color approval.

## Captions and audio

Verify whether caption timestamps refer to the final reel timeline. Review reading speed, overlap, truncation, contrast, and safe-area placement in the preview. Never rewrite or retime supplied captions without user authorization.

Treat beat detection as editorial assistance. Set music and camera-audio gains deliberately, listen to the preview, and confirm that camera audio should be used rather than assuming it. Final loudness normalization cannot repair poor creative mixing.

## Validate and review

Run `validate-edit` before every rough preview. Treat duration warnings, stabilization fallback choices, black/frozen diagnostic warnings, and ambiguous crop subjects as human-review items even when schema validation passes.
At the rough-cut gate, explicitly report for every shot: subject/count, intended placement, crop mode, whether the required subject remains visible with margin, and whether the crop motion feels natural. If any answer is no or uncertain, revise and regenerate the preview before asking for approval.
