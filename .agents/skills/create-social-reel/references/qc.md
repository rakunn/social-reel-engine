# Render and QC

## Final readiness

Before final rendering, require current edit and color approvals, confirmed source profiles and LUT semantics, checksum-valid inputs and reviewed reference frames, and user-confirmed rights. Run `grade` first to surface LUT or stabilization failures before the long render.

Inspect `analysis/graded-clips.json`. Each stabilized shot reports `applied`, `fallback`, or `disabled`. A fallback is acceptable only when the exact per-shot fallback decision was already approved.

## Output contracts

- Preview: 540×960/30 fps H.264/yuv420p, AAC/48 kHz, fast-start, with BT.709 tags.
- Master: 1080×1920/30 fps ProRes 422 HQ, yuv422p10le, PNG source frames, PCM-16/48 kHz, BT.709.
- Delivery: 1080×1920/30 fps H.264/yuv420p CRF 17, AAC 256 kbps/48 kHz, fast-start, BT.709, measured two-pass normalization targeting −14 LUFS and −1.5 dBTP.

An intentionally silent edit still retains the required AAC track. The engine skips invalid infinite loudness measurements for that case. FFprobe reports the average AAC bitrate produced for the actual content rather than the requested encoder setting; QC records a positive out-of-tolerance average as a warning, while the checksum-bound render policy enforces the requested setting.

The engine records render fingerprints and output checksums. A same-named file is not current unless its record matches the present edit, inputs, source confirmations, LUT declarations, settings, and render policy.

## Required checks

Run QC separately for master and delivery. Review the JSON and Markdown reports for:

- current approvals and current render fingerprint;
- missing or checksum-invalid media;
- readability and duration;
- dimensions, frame rate, codec/profile, pixel format, and color tags;
- audio codec/sample rate/observed average bitrate and MP4 fast-start placement;
- delivery loudness and true peak;
- detected black and frozen sections.

Any failure blocks completion. Black/freeze warnings require human review because they may be intentional. Watch and listen to the full delivery: automated QC cannot judge pacing, crop intent, caption readability, mix quality, color taste, or compression artifacts.

## Completion report

Provide clickable absolute paths to `output/master.mov`, `output/delivery.mp4`, `analysis/qc-master.md`, and `analysis/qc-delivery.md`. State whether QC passed, list reviewed warnings and stabilization outcomes, and identify any remaining limitation without burying it in implementation detail.
