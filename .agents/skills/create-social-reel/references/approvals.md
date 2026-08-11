# Approval protocol

## Ownership

Only an explicit user decision after seeing the exact current artifact authorizes an approval command. Codex may recommend approval or changes, but must not approve on the user's behalf.

## Gate 1: editorial

1. Validate the current edit.
2. Render and inspect `previews/preview.mp4`.
3. Run preview QC.
4. Inspect the full 9:16 motion at each cut and at the first stable frame, midpoint, and final stable frame of every shot. Compare the subject/count and composition contract: required subjects must remain visible with margin, centering must be natural where requested, intentional off-center framing must be preserved, and crop translation must not feel like continuous subject-chasing.
5. Present the absolute preview path and summarize the current edit decisions, including the subject/composition result for every shot.
6. Stop and wait.
7. After the user explicitly approves that version, run `approve-edit`.

Trim, order, crop, playback, transitions, title, music, camera audio, captions, stabilization, source-profile confirmation, or preview-normalization changes make editorial approval stale. Because color approval is bound to the edit hash, they make color approval stale too.

## Gate 2: color

1. Confirm that editorial approval is current.
2. Generate and inspect `previews/graded-stills/*.png`.
3. Present absolute paths and list the exact color chain and blend for each shot.
4. Stop and wait.
5. After the user explicitly approves those frames, run `approve-color`.

Exposure, white balance, tint, technical/combined LUT, creative LUT, creative blend, LUT declaration, or LUT bytes changes make color approval stale. Reference-frame checksums must still match the files that were shown.

## Revisions and resuming

Approval and rights records can remain on disk while becoming logically stale. Trust `status`, hash comparison, and QC rather than the mere presence of timestamps, `rightsConfirmed: true`, or output files. A changed used-asset fingerprint requires explicit rights confirmation and a new `confirm-rights`; an unchanged fingerprint does not require another question.

After an editorial change, repeat both gates. After a grade-only change, retain the current edit approval but regenerate and repeat the color gate. Never reuse a previously rendered preview or still merely because its filename is unchanged.

If the user says “approved” ambiguously, tie the response back to the artifact paths and current checkpoint. Do not interpret approval of a rough cut as approval of color or final rights.
