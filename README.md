# Social Reel Engine

Create vertical social reels and landscape video carousels from local MP4 or MOV footage. Codex manages the edit, FFmpeg and Remotion handle the video pipeline, and librosa analyzes music timing.

Source files stay unchanged. The project records the exact files, edit, color settings, and approvals used for each export.

![Music, clips, LUT, and captions become an edited reel](public/reel-pipeline-natural.webp)

## Before you start

This project is built for local use on macOS and is tested on Apple silicon. You need:

- Codex with this repository open as the workspace
- Node.js 24.12.0 and npm 11.6.2
- Python 3.11
- FFmpeg and ffprobe available on your `PATH`
- enough free disk space for ProRes intermediates

The Node version is pinned in `.nvmrc` and `.node-version`. Python packages are pinned for macOS arm64 in `requirements.txt`.

## Setup

Run this once from the repository root:

```bash
nvm use
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npx remotion browser ensure
npm run reel -- doctor
```

Before creating the virtual environment, check that `python3 --version` reports Python 3.11. If you do not use nvm, select the Node version from `.node-version` with your preferred version manager.

`doctor` checks the runtime versions, available disk space, Remotion compositor, FFmpeg filters and encoders, Python environment, LUT catalog, and style catalog. Fix any failed check before rendering.

## Create your first reel

The normal way to use this repository is through its Codex skill. Open a new Codex task in this workspace, attach your media or provide its local paths, and ask:

> Use $create-social-reel to create a 20–30 second 9:16 reel from my clips and music. The footage was recorded on a DJI Mini 4 Pro in D-Log M. Make it a calm Philippines sunset edit for Instagram, use `philippines-island-editorial`, and choose the shots and captions. I have the rights to use the supplied footage, music, and LUTs.

Include what you know about:

- the output: `9:16 reel` or `1.91:1 video carousel`
- paths to clips, music, captions, LUTs, fonts, and brand assets
- camera model and recording profile, gamma, and gamut
- subject, location, mood, platform, audience, and target duration
- preferred style, captions, shot order, or choices Codex may make
- your right to use the supplied assets

Camera profile information matters for log footage and cannot be inferred safely from appearance. It is fine to leave editorial choices open with directions such as “choose the best LUT” or “choose the opening and closing shots.”

Codex creates a local job under `projects/<reel-name>/`, copies the supplied assets into it, analyzes the media, and builds the rough cut. It then pauses for:

1. rough-cut approval for timing, order, framing, and stabilization
2. color approval based on graded reference stills
3. confirmation that you have the rights to the exact assets used in the edit

After those checks, it renders the final files and runs quality control. Use this command at any time to see the current checkpoint and next action:

```bash
npm run reel -- status <reel-name>
```

## Other output formats

### Landscape carousel

Ask for a `1.91:1 video carousel` when you want ordered, independently shareable video cards. Each card is 1910×1000 and must be 4–5 seconds long. The rough preview covers the full sequence; the final package is published under:

```text
projects/<reel-name>/output/carousel/ready-to-share/
```

Example request:

> Use $create-social-reel to create a 1.91:1 video carousel from these D-Log M clips. Make each card 4–5 seconds, vary adjacent compositions, and use a calm final shot.

### Photo stills

Add this to a reel request when you also want still images:

> After final video QC, export the five best clean stills in 9:16 and 4:5.

Available photo formats are `9:16`, `4:5`, `1:1`, and `16:9`. A 9:16 still reuses the approved video crop. Other formats need a separate reframe review before export.

## Checkpoints

```text
new → ingest → analyze → proxy → beats → rough edit → validate → preview
                                                         ↓
                                                    approve edit
                                                         ↓
                                           grade stills → approve color
                                                         ↓
                                       confirm rights → grade → render
                                                         ↓
                                             master QC → delivery QC
                                                         ↓
                                              optional photo exports
```

Approvals are tied to checksums. If a referenced file or relevant setting changes, `status` reports which approval or output is stale.

## Command-line reference

Codex normally runs these commands for you. The CLI is useful when developing the engine, inspecting a job, or repeating a known step.

```bash
npm run reel -- new island-sunrise --title "Island Sunrise"
npm run reel -- ingest island-sunrise /path/to/clip-1.mp4 /path/to/clip-2.mov --kind clips
npm run reel -- ingest island-sunrise /path/to/music.wav --kind music
npm run reel -- ingest island-sunrise --library dji-mini-4-pro-dlogm-rec709-v1
npm run reel -- style --list
npm run reel -- style island-sunrise --apply philippines-island-editorial
npm run reel -- analyze island-sunrise
npm run reel -- proxy island-sunrise
npm run reel -- beats island-sunrise
```

The edit is stored in `projects/island-sunrise/edits/edit.json`. Once it is ready, continue with:

```bash
npm run reel -- validate-edit island-sunrise
npm run reel -- preview island-sunrise
npm run reel -- approve-edit island-sunrise
npm run reel -- grade-stills island-sunrise
npm run reel -- approve-color island-sunrise
npm run reel -- confirm-rights island-sunrise
npm run reel -- grade island-sunrise
npm run reel -- render island-sunrise
npm run reel -- qc island-sunrise --target master
npm run reel -- qc island-sunrise --target delivery
npm run reel -- status island-sunrise
```

Create a carousel job with:

```bash
npm run reel -- new loboc-river --title "Loboc River" --format carousel-1.91:1
```

After the common edit, color, rights, and grading steps, finish it with:

```bash
npm run reel -- render-carousel loboc-river
npm run reel -- qc-carousel loboc-river
npm run reel -- status loboc-river
```

Create photo stills after the master and delivery outputs pass QC:

```bash
npm run reel -- photos island-sunrise --aspect 9:16 4:5 --count 5
# Review previews/photo-candidates/4x5/contact-sheet.jpg.
npm run reel -- approve-photos island-sunrise
npm run reel -- photos island-sunrise
```

Useful catalog commands:

```bash
npm run reel -- ingest <reel-name> --list-library
npm run reel -- style --list
```

Installing a catalog LUT copies it into the job and checks its SHA-256 checksum and declared color spaces. Applying a style preset downloads its required commit-pinned Google Fonts, verifies them, and copies them into the job. Run `analyze` again after adding either one.

For the complete command list:

```bash
npm run reel -- --help
```

## Color and asset safety

Color processing follows this order:

```text
shot exposure, white balance, and tint
→ technical normalization LUT
→ optional creative LUT at the approved strength
→ Rec.709 output
```

A combined technical and creative LUT replaces both LUT stages. It is not stacked with another normalizer.

Final grading stops when the source camera profile or LUT color-space declaration is missing or inconsistent. You can still make a watermarked proxy from unresolved log footage, but it is not suitable for color approval.

The local catalog includes:

- DJI Mini 4 Pro D-Log M → Rec.709
- Sony S-Log3/S-Gamut3.Cine → Rec.709
- Sony S-Log3/S-Gamut3 → Rec.709
- 18 Szatrasie creative looks, normally adjusted per shot
- `HDR CONVERSION LUT.cube`, blocked until its input, output, and purpose are known

Style presets affect typography, palette, spacing, shadows, and fades. They do not change exposure, white balance, contrast, or LUT selection. See [`library/README.md`](library/README.md) for catalog details.

Run `confirm-rights` only after confirming the assets used by the current edit. The confirmation is tied to their checksums and becomes stale if that set changes.

## Project layout

Each job is self-contained:

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
│   ├── luts.json
│   ├── style.json
│   └── photos.json
├── analysis/
├── edits/edit.json
├── work/
├── previews/
└── output/
```

Runtime jobs are local and ignored by Git. This includes media, edit manifests, approvals, analysis, previews, QC reports, and rendered files. Reusable defaults live under `templates/reel/`.

## Outputs

For a vertical reel, the main files are:

- `output/master.mov`: 1080×1920, 30 fps, ProRes 422 HQ, 10-bit 4:2:2, PCM audio
- `output/delivery.mp4`: H.264, AAC, fast-start, BT.709, normalized to −14 LUFS and −1.5 dBTP

The preview is 540×960 H.264. Carousel cards are 1910×1000 H.264 files. Photo exports are quality-95 JPEGs with an sRGB profile.

QC reports are written to `analysis/` in JSON and Markdown. They cover freshness, missing media, dimensions, duration, frame rate, codecs, color tags, audio, fast-start placement, loudness, black or frozen sections, and text readability. A failed check blocks completion.

## Development checks

Run the full project verification with:

```bash
npm run verify
```

Or run each check separately:

```bash
npm run typecheck
npm run test
npm run test:e2e
npm run reel -- doctor
```

The end-to-end suite builds temporary synthetic media, renders preview, master, delivery, carousel, and photo outputs, runs QC, and confirms that the source files remain unchanged.
