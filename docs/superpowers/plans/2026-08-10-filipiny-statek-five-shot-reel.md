# Filipiny Statek Five-Shot Reel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a checksum-bound 12–13 second cinematic 9:16 reel from the strongest moment in each of five supplied DJI Mini 4 Pro D-Log M clips, with no music, source audio, text, or captions.

**Architecture:** Create one isolated `projects/filipiny-statek-five-shot` job and use only the repository's `npm run reel -- ...` workflow for ingest, analysis, normalization, previewing, approvals, grading, rendering, and QC. Keep media immutable, derive editorial values from generated source IDs and visual proxy analysis, and stop at both user-owned approval gates.

**Tech Stack:** Node.js 24.12.0, npm 11.6.2, the repository reel CLI, FFmpeg/ffprobe, Remotion 4.0.507, the declared local DJI technical LUT, and the engine's JSON/Markdown QC reports.

## Global Constraints

- Work from `/Users/rafalbagrowski/Documents/reels` and invoke every workflow stage through the repository's `npm run reel --` CLI with reel name `filipiny-statek-five-shot`.
- Ingest immutable copies of all five supplied files; never edit or overwrite the originals on `/Volumes/T7 Shield`.
- Use all five sources exactly once, selecting only the strongest 2–3 second moment from each.
- Target 12–13 seconds, with 12.5 seconds as the ideal timeline duration; output is 1080×1920 at 30 fps and preview is 540×960 at 30 fps.
- Order shots by motion, scale, direction, and visual impact rather than capture time.
- Use selective 0.50051× playback only when it improves motion; this remains just above the 59.94-to-30 fps frame-synthesis boundary. Otherwise use 1.0×.
- Use direct motion-matched cuts by default and no more than one restrained `fade` transition.
- Use subject-aware animated 9:16 crops; do not blindly center-crop the 16:9 footage.
- Stabilization is off unless proxy review reveals distracting motion. If enabled, use `fallbackToUnstabilized: false`.
- The reel is intentionally silent: every shot is muted, `music` is `null`, and there are no titles or captions.
- User-confirmed source profile: DJI Mini 4 Pro, profile `dji-mini-4-pro-d-log-m`, gamma `D-Log M`, gamut `DJI D-Log M`.
- Apply exactly one full-strength technical transform, catalog ID `dji-mini-4-pro-dlogm-rec709-v1`; start with no creative LUT.
- Keep `rightsConfirmed` false until the user explicitly confirms usage rights. Never infer or pre-set rights.
- Never run `approve-edit` or `approve-color` until the user has reviewed and explicitly approved the exact current artifact.

## File Map

- Create through the engine: `projects/filipiny-statek-five-shot/`
- Modify: `projects/filipiny-statek-five-shot/brief.json` — duration, silent-output options, and internal notes; keep rights false.
- Modify: `projects/filipiny-statek-five-shot/config/sources.json` — exact confirmation for each ingested video path.
- Generate through catalog ingest: `projects/filipiny-statek-five-shot/config/luts.json` — one declared DJI technical LUT.
- Generate and inspect: `projects/filipiny-statek-five-shot/analysis/sources.json`, `analysis/proxies.json`, representative frames, and contact sheets.
- Modify: `projects/filipiny-statek-five-shot/edits/edit.json` — the five-shot timeline and all crop, rate, stabilization, grade, audio, and transition decisions.
- Generate and inspect at Gate 1: `projects/filipiny-statek-five-shot/previews/preview.mp4` and `analysis/qc-preview.{json,md}`.
- Generate and inspect at Gate 2: `projects/filipiny-statek-five-shot/previews/graded-stills/*.png`.
- Generate after both approvals and rights confirmation: `output/master.mov`, `output/delivery.mp4`, `analysis/qc-master.{json,md}`, and `analysis/qc-delivery.{json,md}`.
- Do not modify files under `src/`, `templates/`, or `library/`.

---

### Task 1: Preflight, Immutable Intake, and Confirmed Normalization

**Files:**
- Create: `projects/filipiny-statek-five-shot/`
- Modify: `projects/filipiny-statek-five-shot/brief.json`
- Modify: `projects/filipiny-statek-five-shot/config/sources.json`
- Generate: `projects/filipiny-statek-five-shot/config/luts.json`
- Generate: `projects/filipiny-statek-five-shot/analysis/ingest.json`
- Generate: `projects/filipiny-statek-five-shot/analysis/sources.json`

**Interfaces:**
- Consumes: the five absolute MP4 paths, explicit user confirmation of D-Log M, and catalog record `dji-mini-4-pro-dlogm-rec709-v1`.
- Produces: five checksum-verified video sources with stable source IDs and exactly one compatible D-Log M → Rec.709 normalizer.

- [ ] **Step 1: Verify the local toolchain**

Run:

```bash
npm run reel -- doctor
```

Expected: Node, npm, FFmpeg/ffprobe, Remotion, Python/librosa, and LUT-library checks pass. Resolve any failed prerequisite before creating the job.

- [ ] **Step 2: Create the isolated job**

Run:

```bash
npm run reel -- new filipiny-statek-five-shot --title "Filipiny Statek — Five-Shot Cinematic"
```

Expected: `projects/filipiny-statek-five-shot` is created once. If it already exists because execution is resuming, do not delete or recreate it; run `npm run reel -- status filipiny-statek-five-shot` and continue from the reported checkpoint.

- [ ] **Step 3: Configure the approved duration and silent format**

Use `apply_patch` to change only these values in `brief.json`:

```json
{
  "target": {"minSeconds": 12, "idealSeconds": 12.5, "maxSeconds": 13},
  "options": {"music": false, "captions": false, "cameraAudio": false},
  "rightsConfirmed": false,
  "notes": "Five-shot visual crescendo. Use every supplied DJI Mini 4 Pro D-Log M clip once; no music, source audio, titles, or captions."
}
```

Preserve the generated `schemaVersion`, `identity`, `output`, and `style` fields.

- [ ] **Step 4: Ingest all five source clips as immutable copies**

Run:

```bash
npm run reel -- ingest filipiny-statek-five-shot "/Volumes/T7 Shield/content/2026 Filipiny/statek/04.16/DJI_20260416114818_0099_D.MP4" "/Volumes/T7 Shield/content/2026 Filipiny/statek/04.16/DJI_20260416113923_0087_D.MP4" "/Volumes/T7 Shield/content/2026 Filipiny/statek/04.16/DJI_20260416113942_0088_D.MP4" "/Volumes/T7 Shield/content/2026 Filipiny/statek/04.16/DJI_20260416114011_0089_D.MP4" "/Volumes/T7 Shield/content/2026 Filipiny/statek/04.16/DJI_20260416114059_0090_D.MP4" --kind clips
npm run reel -- analyze filipiny-statek-five-shot
```

Expected: five files are copied under `input/clips/`, checksummed, and reported as five video sources without altering the originals.

- [ ] **Step 5: Record the exact user-confirmed source profile**

Use `apply_patch` to replace the empty `sources` object in `config/sources.json` with these five entries:

```json
{
  "schemaVersion": "1.0.0",
  "sources": {
    "input/clips/DJI_20260416114818_0099_D.MP4": {"manufacturer": "DJI", "model": "DJI Mini 4 Pro", "gamma": "D-Log M", "gamut": "DJI D-Log M", "profileId": "dji-mini-4-pro-d-log-m", "confirmed": true},
    "input/clips/DJI_20260416113923_0087_D.MP4": {"manufacturer": "DJI", "model": "DJI Mini 4 Pro", "gamma": "D-Log M", "gamut": "DJI D-Log M", "profileId": "dji-mini-4-pro-d-log-m", "confirmed": true},
    "input/clips/DJI_20260416113942_0088_D.MP4": {"manufacturer": "DJI", "model": "DJI Mini 4 Pro", "gamma": "D-Log M", "gamut": "DJI D-Log M", "profileId": "dji-mini-4-pro-d-log-m", "confirmed": true},
    "input/clips/DJI_20260416114011_0089_D.MP4": {"manufacturer": "DJI", "model": "DJI Mini 4 Pro", "gamma": "D-Log M", "gamut": "DJI D-Log M", "profileId": "dji-mini-4-pro-d-log-m", "confirmed": true},
    "input/clips/DJI_20260416114059_0090_D.MP4": {"manufacturer": "DJI", "model": "DJI Mini 4 Pro", "gamma": "D-Log M", "gamut": "DJI D-Log M", "profileId": "dji-mini-4-pro-d-log-m", "confirmed": true}
  }
}
```

- [ ] **Step 6: Verify and install the single matching technical transform**

Run:

```bash
npm run reel -- ingest filipiny-statek-five-shot --list-library
npm run reel -- ingest filipiny-statek-five-shot --library dji-mini-4-pro-dlogm-rec709-v1
npm run reel -- analyze filipiny-statek-five-shot
```

Expected: `config/luts.json` contains one technical normalization LUT whose camera model, profile ID, input gamma, input gamut, semantics, checksum, and full-strength mix exactly match all five confirmed sources.

- [ ] **Step 7: Verify intake state and source integrity**

Run:

```bash
npm run reel -- status filipiny-statek-five-shot
```

Inspect `analysis/sources.json`, `config/sources.json`, and `config/luts.json`. Expected: five video sources; 3840×2160 HEVC Main 10; 60000/1001 fps; no audio stream; every camera record is confirmed; exactly one compatible technical LUT is declared; status requests proxy/edit work.

- [ ] **Step 8: Keep the intake state local**

Run:

```bash
npm run reel -- status filipiny-statek-five-shot
```

Expected: the project remains under the Git-ignored `projects/` tree. Do not force-add its configuration, JSON/Markdown analysis, copied MP4 files, or LUT bytes.

---

### Task 2: Normalized Proxy Analysis and Shot Selection

**Files:**
- Generate: `projects/filipiny-statek-five-shot/analysis/proxies.json`
- Generate: `projects/filipiny-statek-five-shot/analysis/frames/*.jpg`
- Generate: `projects/filipiny-statek-five-shot/analysis/contact-sheets/*.jpg`
- Generate: `projects/filipiny-statek-five-shot/work/proxies/*.mp4`

**Interfaces:**
- Consumes: five confirmed sources and the exact catalog normalizer from Task 1.
- Produces: one strongest source interval, crop path, playback rate, and stabilization decision for each source, plus a proposed five-shot order.

- [ ] **Step 1: Generate technically normalized viewing proxies**

Run:

```bash
npm run reel -- proxy filipiny-statek-five-shot
```

Expected: `analysis/proxies.json` lists five proxy items with normalization `technical`, normalizer file `input/luts/technical/DJI Mini 4 Pro D-Log M to Rec.709 V1.cube`, and no unconfirmed-profile watermark. Do not run `beats`; no music was supplied.

- [ ] **Step 2: Inspect every source across time**

Review all five full proxy videos, all representative frames, and every contact sheet. For each source, record the strongest continuous interval based on subject readability, clean motion, horizon stability, entrance/exit energy, and crop feasibility. Reject takeoff/landing wobble, abrupt gimbal correction, obstructed subject, and near-duplicate moments.

- [ ] **Step 3: Define the visual crescendo**

Order the five selected moments so scale, motion direction, and visual impact progress across the reel. Assign IDs `shot-01` through `shot-05` in final timeline order. Use each source ID from `analysis/sources.json` exactly once.

- [ ] **Step 4: Decide rate, crop, and stabilization per shot**

For each shot:

- choose 1.0× unless 0.50051× clearly improves motion while remaining above the 59.94-to-30 fps frame-synthesis boundary;
- set crop start/end `x` and `y` from subject tracking and use the minimum safe scale between 1 and 4;
- verify the subject and horizon remain safe through the entire animated crop;
- leave stabilization disabled with strength `0` unless visible jitter remains;
- if stabilization is necessary, use a restrained strength no greater than `0.35` and set `fallbackToUnstabilized` to `false`.

Expected: five editorial decisions capable of producing a 12–13 second timeline without repeated media.

---

### Task 3: Author, Validate, Render, and Review the Rough Cut

**Files:**
- Modify: `projects/filipiny-statek-five-shot/edits/edit.json`
- Generate: `projects/filipiny-statek-five-shot/previews/preview.mp4`
- Generate: `projects/filipiny-statek-five-shot/analysis/qc-preview.json`
- Generate: `projects/filipiny-statek-five-shot/analysis/qc-preview.md`

**Interfaces:**
- Consumes: the five verified source IDs and shot decisions from Task 2.
- Produces: the exact Gate 1 rough-cut artifact and its passing/reviewed preview QC report.

- [ ] **Step 1: Author the complete edit manifest**

Use `apply_patch` to populate `edits/edit.json` with these enforced values:

- output: 1080×1920 at 30 fps;
- clips: exactly five entries named `shot-01` through `shot-05` in the chosen visual order;
- each source ID appears exactly once with measured in/out seconds from proxy inspection;
- total timeline duration, after playback rates and transition overlap, is 12–13 seconds;
- crop start/end points contain the inspected subject-tracking coordinates;
- grade baseline on every shot is exposure `0`, white balance `6500`, tint `0`, technical LUT `dji-mini-4-pro-dlogm-rec709-v1`, creative LUT `null`, combined LUT `null`, creative mix `0`;
- audio on every shot is muted with gain `-60` dB;
- transitions are `none` with duration `0` except for at most one evidence-backed `fade` between `0.15` and `0.30` seconds;
- titles is `[]`, music is `null`, and captions is `null`.

- [ ] **Step 2: Validate before rendering**

Run:

```bash
npm run reel -- validate-edit filipiny-statek-five-shot
```

Expected: validation has no failures and reports a duration from 12.00 through 13.00 seconds. The engine's generic 20–30 second recommendation may warn; explicitly record it as reviewed and accepted because the user requested 10–15 seconds and approved a 12–13 second design.

- [ ] **Step 3: Render and QC the exact rough preview**

Run:

```bash
npm run reel -- preview filipiny-statek-five-shot
npm run reel -- qc filipiny-statek-five-shot --target preview
```

Expected: a readable 540×960, 30 fps, H.264/yuv420p, BT.709, fast-start preview with a valid silent AAC track and no QC failures.

- [ ] **Step 4: Inspect the rendered preview itself**

Watch the complete `previews/preview.mp4` and inspect frame samples at every cut. Verify all five sources appear once, pace builds, crop motion tracks the subject, horizons remain safe, 0.50051× footage is smooth, the optional fade is restrained, and there are no unintended black/frozen sections, text, audible content, or compression defects. Review every warning in `analysis/qc-preview.md`.

If any timeline, crop, rate, transition, grade baseline, audio, or stabilization decision changes, repeat Steps 2–4 and discard the stale review artifact.

- [ ] **Step 5: Keep the reviewed rough-cut state local**

Run:

```bash
npm run reel -- status filipiny-statek-five-shot
```

Expected: the reviewed rough-cut state remains available locally and is not force-added to Git.

- [ ] **Step 6: Stop at editorial approval**

Run:

```bash
npm run reel -- status filipiny-statek-five-shot
```

Present the absolute clickable path to `previews/preview.mp4` and report exact shot order, duration, crop motion, playback rates, transition choice, silent audio state, absence of graphics, stabilization decisions, normalization chain, and reviewed warnings. End the turn without running `approve-edit`.

---

### Task 4: User-Approved Editorial Gate and Neutral Color References

**Files:**
- Modify only after explicit preview approval: `projects/filipiny-statek-five-shot/analysis/approvals.json`
- Generate: `projects/filipiny-statek-five-shot/previews/graded-stills/*.png`

**Interfaces:**
- Consumes: explicit user approval of the exact current `previews/preview.mp4`.
- Produces: technically normalized, hash-bound neutral reference PNGs for Gate 2.

- [ ] **Step 1: Bind the user's editorial approval**

Only after the user explicitly approves the displayed rough preview, run:

```bash
npm run reel -- approve-edit filipiny-statek-five-shot
```

Expected: edit approval is current for the exact reviewed timeline hash.

- [ ] **Step 2: Generate neutral graded references**

Run:

```bash
npm run reel -- grade-stills filipiny-statek-five-shot
```

Expected color chain for every shot: exposure/WB/tint baseline → `dji-mini-4-pro-dlogm-rec709-v1` at full strength → no creative LUT → Rec.709.

- [ ] **Step 3: Inspect and match all color references**

Inspect every PNG for clipping, crushed shadows, blown highlights, casts, horizon/sky consistency, neutral balance, and shot-to-shot matching. If exposure, white balance, or tint changes are required, patch the relevant shot grade, rerun `grade-stills`, and inspect the newly generated checksummed PNGs. Do not install a creative LUT unless the user requests a look after seeing actual frames.

- [ ] **Step 4: Stop at color approval**

Present clickable absolute paths to every current PNG and state the exact technical transform and creative blend (`none`, mix `0`) per shot. End the turn without running `approve-color`.

---

### Task 5: User-Approved Color Gate, Rights Gate, Final Render, and QC

**Files:**
- Modify only after explicit color approval: `projects/filipiny-statek-five-shot/analysis/approvals.json`
- Modify only after explicit user rights confirmation: `projects/filipiny-statek-five-shot/brief.json`
- Generate: `projects/filipiny-statek-five-shot/analysis/graded-clips.json`
- Generate: `projects/filipiny-statek-five-shot/output/master.mov`
- Generate: `projects/filipiny-statek-five-shot/output/delivery.mp4`
- Generate: `projects/filipiny-statek-five-shot/analysis/qc-master.{json,md}`
- Generate: `projects/filipiny-statek-five-shot/analysis/qc-delivery.{json,md}`

**Interfaces:**
- Consumes: explicit user approval of the current graded PNGs and explicit user confirmation of rights for every supplied/used asset.
- Produces: current ProRes master, H.264 delivery, two passing QC reports, and final status.

- [ ] **Step 1: Bind color approval and enforce rights**

Only after explicit approval of the displayed current PNGs, run:

```bash
npm run reel -- approve-color filipiny-statek-five-shot
```

Then check `brief.json`. If `rightsConfirmed` is still false, stop and request the user's explicit rights confirmation. Do not change it based on presumed ownership.

- [ ] **Step 2: Grade approved shot intermediates**

After rights are explicitly confirmed and recorded, run:

```bash
npm run reel -- grade filipiny-statek-five-shot
```

Inspect `analysis/graded-clips.json`. Every stabilization result must match the approved decision: `disabled` for unstabilized shots or `applied` for enabled shots. Any unexpected fallback blocks rendering and returns the workflow to editorial review.

- [ ] **Step 3: Render master and delivery**

Run:

```bash
npm run reel -- render filipiny-statek-five-shot
```

Expected master: 1080×1920/30 fps ProRes 422 HQ, yuv422p10le, PCM-16/48 kHz, BT.709. Expected delivery: 1080×1920/30 fps H.264/yuv420p CRF 17, silent AAC requested at 256 kbps/48 kHz, fast-start, BT.709.

- [ ] **Step 4: Run both required QC targets**

Run:

```bash
npm run reel -- qc filipiny-statek-five-shot --target master
npm run reel -- qc filipiny-statek-five-shot --target delivery
npm run reel -- status filipiny-statek-five-shot
```

Expected: both reports are readable, approvals and fingerprints are current, media checksums match, codec/dimension/frame-rate/pixel-format/color tags pass, and there are no failures. Review silent-AAC bitrate warnings and any black/frozen-section warnings instead of treating them as automatic failures.

- [ ] **Step 5: Perform full-delivery human QC**

Watch the entire `output/delivery.mp4`. Confirm pacing, crop intent, horizon safety, color match, transition restraint, silence, and compression quality. Do not claim completion if either report fails, the output is stale/unreadable, or a warning is unreviewed.

- [ ] **Step 6: Keep final job metadata local and report delivery**

Run:

```bash
npm run reel -- status filipiny-statek-five-shot
```

Expected: final metadata and deliverables remain in the ignored local job; no `projects/filipiny-statek-five-shot` file is force-added to Git.

Deliver absolute clickable paths to `output/master.mov`, `output/delivery.mp4`, `analysis/qc-master.md`, and `analysis/qc-delivery.md`, plus concise QC, warning, and stabilization outcomes.
