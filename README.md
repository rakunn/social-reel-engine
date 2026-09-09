# Social Reel Engine

Create vertical social reels and landscape video carousels from local MP4 or MOV footage. Codex manages the edit, FFmpeg and Remotion handle the video pipeline, and librosa analyzes music timing.

Source files stay unchanged. The project records the exact files, edit, color settings, and approvals used for each export.

![Music, clips, LUT, and captions become an edited reel](public/reel-pipeline-natural.webp)

## Setup

Use macOS and keep this repository and its dependencies fully downloaded, preferably outside an iCloud/Dropbox/OneDrive-managed folder. Setup needs internet access for pinned dependencies and the Remotion browser. Allow at least 8 GiB of free space; 40 GiB or more is recommended for repeated ProRes renders.

The Node version is pinned in `.nvmrc` and `.node-version`. Install these prerequisites before running setup:

- Node.js 24.12.0 with npm 11.6.2. If you use nvm, install/load nvm first, then run `nvm install` and `nvm use` in this repository. If npm differs, run `npm install --global npm@11.6.2` in that selected Node runtime.
- Python 3.11 with `python3.11` on your PATH. The pinned Python requirements target macOS arm64 / Python 3.11; other architectures are not covered by this setup verification.
- FFmpeg and ffprobe on your PATH, with libx264, ProRes, AAC, LUT, zscale, drawtext, stabilization (`vidstabdetect`/`vidstabtransform`), and loudness support. `doctor` checks the complete required filter/encoder set. Custom binaries can be selected with `REEL_FFMPEG_PATH` and `REEL_FFPROBE_PATH`.
- Codex with this repository opened as its workspace for the guided workflow. The repository includes `.agents/skills/create-social-reel/`; no separate skill download is needed.

From the repository root:

```bash
bash scripts/setup.sh --check  # Report all missing prerequisites without installing anything
bash scripts/setup.sh         # Install project dependencies, browser, and run doctor
```

`npm run setup` runs the same script. It does not install or change system tools. To perform its installation steps manually after checking prerequisites:

```bash
npm ci
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npx remotion browser ensure
npm run reel -- doctor
```

Success is `"ok": true` from `doctor`. An absent optional LUT library is normal: **LUTs are supplied by the user**, copied into individual jobs, and validated against the recording profile. Catalog metadata alone does not mean a LUT file is installed. Remotion packages are pinned to 4.0.507 and librosa to 0.11.0.

If `doctor` reports dataless/offloaded dependencies, use a fully local copy of the repository and rerun setup there. Preserve your original media and local `projects/` jobs; they are not in Git. If an existing `.venv` uses another Python version, move it aside before setup. If FFmpeg capabilities are missing, select a build containing the reported requirements and rerun `doctor`.

## Create your first reel

The normal way to use this repository is through its Codex skill. Open a new Codex task in this workspace, attach your media or provide its local paths, and ask:

> Use $create-social-reel to create a 20–30 second 9:16 reel from my clips and music. The footage was recorded on a DJI Mini 4 Pro in D-Log M. Make it a calm Philippines sunset edit for Instagram, use `philippines-island-editorial`, and choose the shots and captions. Ask for any missing required LUTs or technical facts, and ask me to explicitly confirm usage rights.

Include what you know about:

- the output: `9:16 reel` or `1.91:1 video carousel`
- paths to clips, music, captions, LUTs, fonts, and brand assets
- camera model and recording profile, gamma, and gamut
- subject, location, mood, platform, audience, and target duration
- preferred style, captions, shot order, or choices Codex may make
- your right to use the supplied assets

Camera profile information matters for log footage and cannot be inferred safely from appearance. It is fine to leave editorial choices open with directions such as “choose the best LUT” or “choose the opening and closing shots.”

Before expensive media work, Codex checks `status` and collects currently knowable missing inputs and profile/transform facts in one intake request. It includes explicit rights confirmation once a valid edit resolves the used assets. A required missing LUT is requested from you, then copied with `ingest` into the job's `input/luts/technical/` or `input/luts/creative/`. If the file is already supplied, Codex requests only unresolved transform facts. Creative LUTs are optional.

Codex writes `config/sources.json`, `config/luts.json`, and `edits/edit.json`; you do not need to author JSON or prescribe every creative setting. It chooses sensible trims, crops, corrections, and typography from your brief and presents the results for review. An unresolved technical profile or transform permits only the watermarked proxy/rough path until resolved.

Rights always require an explicit user statement covering the assets used. Supplying files, selecting a style, or having a license label does not count. Codex presents the inventory and asks for confirmation; after your response covers the current used set, it runs `confirm-rights`. A valid existing confirmation remains usable while that exact used set is unchanged.

Codex creates a local job under `projects/<reel-name>/`, copies the supplied assets into it, analyzes the media, and builds the rough cut. It pauses twice for visual review:

1. rough-cut approval for timing, order, framing, and stabilization
2. color approval based on graded reference stills

After those checks, Codex renders the final files and runs quality control. Use this command at any time to see the current checkpoint and next action:

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

Codex normally runs these commands for you. This is a staged reference, not an unattended copy-and-paste script: replace the example paths and complete the configuration and review steps between commands.

`status` returns structured `intake.requirements`: `ask-user` items need missing facts/files or explicit rights; `configure` items are work Codex can do from verified information. Its rights inventory is labeled as supplied or used assets and includes checksums. Active media jobs return only lightweight activity status.

`intake.rights.status` is `confirmed`, `unconfirmed`, or `indeterminate`. Rights prompts require a valid edit and a nonempty, resolved used-asset inventory, including required LUT selections and verified profile/transform metadata. When the project is empty, the edit is incomplete, or missing assets/configuration errors prevent resolving that inventory, finish intake and configuration, then rerun `status`. Defer both first-time confirmation and reconfirmation until the inventory can be verified; preserve any existing confirmation during the repair.

If stage checks fail because configuration or review metadata is invalid, `status` preserves the intake report and returns `awaiting-configuration` with the underlying error and repair guidance.

```bash
npm run reel -- new island-sunrise --title "Island Sunrise"
npm run reel -- ingest island-sunrise /path/to/clip-1.mp4 /path/to/clip-2.mov --kind clips
npm run reel -- ingest island-sunrise /path/to/music.wav --kind music
npm run reel -- ingest island-sunrise /path/to/normalizer.cube --kind technical-lut
# Optional: ingest /path/to/look.cube with --kind creative-lut.
npm run reel -- style --list
npm run reel -- style island-sunrise --apply philippines-island-editorial
npm run reel -- status island-sunrise
# Resolve the consolidated intake: confirm recording facts, LUT semantics, and rights.
# Write verified source profiles to config/sources.json and LUT declarations to config/luts.json.
npm run reel -- analyze island-sunrise
npm run reel -- proxy island-sunrise
npm run reel -- beats island-sunrise # Only when one music track is supplied.
```

Codex authors `projects/island-sunrise/edits/edit.json` using analyzed source IDs, trims, crops, audio, and selected LUT IDs. `analyze` does not select shots or create an edit. For manual JSON authoring, see the [input configuration guidance](.agents/skills/create-social-reel/references/inputs.md), [editing guidance](.agents/skills/create-social-reel/references/editing.md), and [validated schemas](src/contracts/schemas.ts). Rerun `analyze` after changing source confirmations or LUT declarations. Once the edit is ready, continue with:

```bash
npm run reel -- validate-edit island-sunrise
# Only after explicit user rights confirmation covers the current used set:
npm run reel -- confirm-rights island-sunrise
npm run reel -- preview island-sunrise
npm run reel -- qc island-sunrise --target preview
# Present previews/preview.mp4. Stop until the user explicitly approves this rough cut.
npm run reel -- approve-edit island-sunrise
# Source profiles and the normalization transform must be resolved before color work.
npm run reel -- grade-stills island-sunrise
# Present previews/graded-stills/. Stop until the user explicitly approves this grade.
npm run reel -- approve-color island-sunrise
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
# Review previews/photo-candidates/4x5/contact-sheet.jpg; wait for explicit reframe approval.
npm run reel -- approve-photos island-sunrise
npm run reel -- photos island-sunrise
```

Useful catalog commands:

```bash
npm run reel -- ingest <reel-name> --list-library
npm run reel -- style --list
```

Catalog metadata is optional and does not include LUT binaries. When its matching file is installed locally, `ingest <reel-name> --library <id>` copies it into the job and checks its SHA-256 checksum and declared color spaces. Otherwise supply the file through typed ingest and record verified metadata; the workflow does not download or substitute LUTs based on their names. Applying a style preset downloads its required commit-pinned Google Fonts, verifies them, and copies them into the job. Run `analyze` again after adding either one.

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

The optional local catalog describes these user-supplied LUTs; binaries and the guide are excluded from Git:

- DJI Mini 4 Pro D-Log M → Rec.709
- Sony S-Log3/S-Gamut3.Cine → Rec.709
- Sony S-Log3/S-Gamut3 → Rec.709
- 18 Szatrasie creative looks, normally adjusted per shot
- `HDR CONVERSION LUT.cube`, blocked until its input, output, and purpose are known

Style presets affect typography, palette, spacing, shadows, and fades. They do not change exposure, white balance, contrast, or LUT selection. See [`library/README.md`](library/README.md) for catalog details.

Run `confirm-rights` only after the user explicitly confirms permission to use the assets selected by the current edit; supplying files or license metadata does not count. The confirmation is tied to their checksums and becomes stale if that set changes.

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
npm run reel -- doctor
npm run typecheck
npm run test
npm run test:e2e
```

Tests use synthetic fixtures and do not require your LUT library or footage. The real music-analysis test allows 120 seconds because a fresh Python environment can take over a minute on its first analysis. Tests need process inspection (`ps`) and local browser execution; restrictive agent sandboxes may require permission to run them.

The end-to-end suite builds temporary synthetic media, renders preview, master, delivery, carousel, and photo outputs, runs QC, and confirms that the source files remain unchanged.
