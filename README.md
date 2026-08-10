# Social Reel Engine

A local macOS workflow for turning supplied MP4/MOV footage into cinematic 9:16 social reels with Codex, FFmpeg, Remotion, and librosa. Originals remain unchanged. Every generated artifact is checksum-bound, color transforms are explicit, and final exports require current edit and color approvals.

## Start a reel in a new Codex task

Open this folder as the workspace, attach or provide paths to your clips/music/captions, then ask:

> Use $create-social-reel to create a 20–30 second cinematic vertical reel from the clips, music, captions, and LUTs I provide.

The skill creates `projects/<reel-name>`, ingests local copies of the supplied files, analyzes them, and pauses at the two visual checkpoints. It never chooses an unconfirmed technical transform. Per-shot stabilization is baked into the rough preview, so the approved framing is the framing used downstream.

## One-time local setup

```bash
nvm use
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npx remotion browser ensure
npm run reel -- doctor
```

Pinned runtime:

- Node.js 24.12.0 and npm 11.6.2
- Remotion packages 4.0.507
- Python 3.11 virtual environment with librosa 0.11.0
- Local FFmpeg/ffprobe with LUT, zscale, stabilization, H.264, ProRes, AAC, and loudness support

## Workflow and checkpoints

```text
new → ingest → analyze → proxy → beats → rough edit → validate → preview
                                                         ↓
                                                approve-edit (pause 1)
                                                         ↓
                                  grade-stills → approve-color (pause 2)
                                                         ↓
                                          grade → render → qc
```

Typical commands:

```bash
npm run reel -- new island-sunrise --title "Island Sunrise"
npm run reel -- ingest island-sunrise /path/to/clip-1.mp4 /path/to/clip-2.mov --kind clips
npm run reel -- ingest island-sunrise /path/to/music.wav --kind music
npm run reel -- ingest island-sunrise --library dji-mini-4-pro-dlogm-rec709-v1
npm run reel -- analyze island-sunrise
npm run reel -- proxy island-sunrise
npm run reel -- beats island-sunrise
npm run reel -- validate-edit island-sunrise
npm run reel -- preview island-sunrise
npm run reel -- approve-edit island-sunrise
npm run reel -- grade-stills island-sunrise
npm run reel -- approve-color island-sunrise
npm run reel -- grade island-sunrise
npm run reel -- render island-sunrise
npm run reel -- qc island-sunrise --target delivery
npm run reel -- status island-sunrise
```

Use `npm run reel -- ingest <name> --list-library` to inspect the local LUT catalog. Catalog installation copies the LUT into the job, verifies its SHA-256 checksum, and writes its declared semantics into `config/luts.json`.

## Color safety

The enforced order is:

```text
shot exposure/white balance/tint
→ exact technical normalization LUT
→ optional creative LUT at an approved blend
→ Rec.709 output
```

A combined technical/creative LUT replaces the technical and creative stages; it is never stacked with a second normalizer. Grading and final export stop when camera model, canonical input gamma, canonical input gamut, profile ID, LUT metadata, file checksum, or transform semantics are missing or mismatched. A rough-cut proxy may still be made, but it is visibly marked as an unnormalized log preview.

The supplied local library contains:

- DJI Mini 4 Pro D-Log M → Rec.709 technical transform
- Sony S-Log3/S-Gamut3.Cine → Rec.709 technical transform
- Sony S-Log3/S-Gamut3 → Rec.709 technical transform
- 18 Szatrasie creative looks, applied after normalization with a default 50% blend
- `HDR CONVERSION LUT.cube`, intentionally blocked until its input/output spaces and semantics are confirmed

The supplied Szatrasie guide recommends tuning creative LUT intensity per shot, generally within 20–80%, and does not prescribe a fixed look by scene. The workflow therefore compares reference frames and asks for approval.

## Job structure

```text
projects/<reel-name>/
├── brief.json
├── input/
│   ├── clips/
│   ├── music/
│   ├── captions/
│   ├── luts/{technical,creative}/
│   ├── fonts/
│   └── brand/
├── config/
│   ├── settings.json
│   ├── sources.json
│   └── luts.json
├── analysis/
├── edits/edit.json
├── work/
├── previews/
└── output/
```

Every runtime `projects/<reel-name>` job is local-only and ignored by Git, including media, metadata, edit manifests, approvals, analysis, previews, QC reports, and renders. Only `projects/.gitkeep` is tracked; reusable scaffold changes belong in `templates/reel/`.

## Output contracts

- Preview: 540×960, 30 fps, H.264/yuv420p, AAC, BT.709
- Master: 1080×1920, 30 fps, ProRes 422 HQ, 10-bit 4:2:2, PCM-16/48 kHz, PNG source frames, BT.709
- Delivery: H.264/yuv420p CRF 17, AAC requested at 256 kbps, fast-start, BT.709, measured two-pass normalization to −14 LUFS and −1.5 dBTP; intentionally silent edits retain a valid AAC track without invalid loudness processing

QC writes `analysis/qc-<target>.json` and `analysis/qc-<target>.md` with approval status, artifact freshness, missing media, duration, dimensions, frame rate, codec/profile, color tags, pixel format, audio codec/rate/observed average bitrate, MP4 fast-start placement, loudness, black sections, frozen sections, and readability. AAC average bitrate is content-dependent, so a positive value outside tolerance is surfaced as a warning while the requested encoder setting remains enforced by the render fingerprint.

## Verification

```bash
npm run typecheck
npm run test
npm run test:e2e
npm run reel -- doctor
```

`npm run test:e2e` creates temporary synthetic media and exercises audible and intentionally silent two-clip reels. It uses non-zero video/music offsets, renders preview/master/delivery outputs, validates all three through QC, and verifies that source checksums did not change.
