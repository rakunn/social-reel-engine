# Approval protocol

## Ownership

Only an explicit user decision after seeing the exact current artifact authorizes an approval command. Codex may recommend approval or changes, but must not approve on the user's behalf.

## Gate 1: editorial

1. Validate the current edit.
2. Render and inspect `previews/preview.mp4`.
3. Run preview QC.
4. Inspect the full motion in the project format at each cut/card boundary and at the first stable frame, midpoint, and final stable frame of every shot. Compare the subject/count and composition contract: required subjects must remain visible with margin, centering must be natural where requested, intentional off-center framing must be preserved, and crop translation must not feel like continuous subject-chasing. For a carousel, confirm that each 4–5 second card stands alone and that the displayed order has the intended hero and closing card.
5. Present the absolute preview path and summarize the current edit decisions, including the subject/composition result for every shot.
6. Stop and wait.
7. After the user explicitly approves that version, run `approve-edit`.

Trim, order, crop, playback, transitions, title, music, camera audio, captions, card text, stabilization, source-profile confirmation, or preview-normalization changes make editorial approval stale. A separate derivative always requires its own rough preview and explicit edit approval.

Color approval has a narrower dependency boundary. Source selection/interval, crop, stabilization, output color dimensions, exposure, white balance, tint, technical/combined/creative LUT choice or declaration, LUT bytes, treatment, and creative blend make it stale. Text, title, audio, music, captions, and transitions do not by themselves invalidate color when the color projection and reviewed-still checksums remain exact. Trust `status`; never preserve color merely from matching filenames or visual similarity.

## Gate 2: color

1. Confirm that editorial approval is current.
2. Generate and inspect `previews/graded-stills/*.png`.
3. Present absolute paths and list the exact color chain and blend for each shot.
4. Stop and wait.
5. After the user explicitly approves those frames, run `approve-color`.

Reference-frame checksums must still match the files that were shown. Graded reference frames isolate color; review card-text styling and contrast in the rough preview.

## Revisions and resuming

Approval and rights records can remain on disk while becoming logically stale. Trust `status`, hash comparison, and QC rather than the mere presence of timestamps, `rightsConfirmed: true`, or output files. A changed used-asset fingerprint requires explicit rights confirmation and a new `confirm-rights`; an unchanged fingerprint does not require another question.

After an editorial-only change, regenerate and repeat the rough gate, then retain color only when `status` still reports it current. After a grade-only change, retain the current edit approval but regenerate and repeat the color gate. Changes such as trim, crop, source, or stabilization affect both and require both gates. Never reuse a previously rendered preview or still merely because its filename is unchanged.

If the user says “approved” ambiguously, tie the response back to the artifact paths and current checkpoint. Do not interpret approval of a rough cut as approval of color or final rights.
