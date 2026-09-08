# Inputs and project intake

## Required intake facts

Collect or discover what is available without forcing the user to repeat facts already supplied:

- project identity, desired title, and output type: `reel-9:16` or `carousel-1.91:1`;
- local paths for MP4/MOV clips and optional music, SRT/Remotion Caption JSON, LUTs, fonts, and brand assets;
- camera model plus recorded gamma and gamut for every clip or homogeneous clip group;
- intended technical LUT and its declared input/output color spaces;
- whether a LUT is technical, creative, or a combined normalization-and-look transform;
- desired mood, hook, title/CTA, caption language, music and camera-audio intent, and any required/forbidden shots;
- which shots may be stabilized and whether an unstabilized fallback is acceptable;
- usage-rights confirmation, supplied only by the user.

Do not block initial ingest merely because creative direction is incomplete. Do block color grading and final export when technical profile facts are incomplete.

After ingest, run `status` and use `intake.requirements` as a structured starting inventory. Group all currently known `ask-user` requirements into one request. `configure` means Codex should author or repair configuration from verified facts; if the underlying fact is unavailable, include that fact in the same request. Missing trims, crop coordinates, shot order, correction values, or LUT blend are normally creative decisions to make and present at the rough/color reviews, not additional intake questions. Ask about output format or conflicting editorial instructions only when resolving them materially changes the result.

Intake reports use all supplied clips until a valid edit identifies selected sources, then restrict source/profile requirements to those selected sources. Rights inventories are explicitly labeled `supplied` or `used`; only the final used-asset fingerprint can bind confirmation. Status is read-only and never confirms rights or authorizes grading. A live media operation returns activity without starting an intake scan.

## Missing LUTs and project storage

The user supplies LUT binaries. An absent optional library is normal on a fresh checkout. Inspect provided paths, project inputs, and verified local catalog files first. If a required compatible technical/combined transform is missing, request the file and any unknown input/output spaces or semantics in the consolidated intake. Once supplied, copy it with `ingest --kind technical-lut` into the job's `input/luts/technical/`; combined LUTs use the same directory but declare `kind: combined` in metadata. Creative looks use `ingest --kind creative-lut` and remain optional.

When a file is already present but undeclared, ask only for missing transform facts and write the verified checksum and metadata into `config/luts.json`. Never infer semantics from filenames or substitute a merely similar camera profile. When a compatible catalog file is installed and checksum-valid, use `ingest --library <id>` instead of requesting it again. Preserve source originals and existing files; same-name/different-content conflicts need a distinct file name rather than an overwrite. Project copies are the default destination; shared library reuse requires matching its declared catalog checksum and metadata.

Every runtime `projects/<reel-name>` job is local-only and ignored by Git, including its metadata and reports. Never use `git add -f` to override that boundary. Put reusable defaults and scaffold changes in `templates/reel/`, not in a live job.

## Typed ingest commands

```text
npm run reel -- new <name> --title "<title>"
npm run reel -- new <name> --title "<title>" --format carousel-1.91:1
npm run reel -- variant <source-name> <target-name> --title "<title>"
npm run reel -- ingest <name> <clip-paths...> --kind clips
npm run reel -- ingest <name> <music-path> --kind music
npm run reel -- ingest <name> <caption-path> --kind captions
npm run reel -- ingest <name> <lut-paths...> --kind technical-lut
npm run reel -- ingest <name> <lut-paths...> --kind creative-lut
npm run reel -- ingest <name> <font-paths...> --kind fonts
npm run reel -- ingest <name> <brand-paths...> --kind brand
npm run reel -- style --list
npm run reel -- style <name> --apply <preset-id>
npm run reel -- confirm-rights <name>
```

Use `--list-library` to inspect catalog declarations and `--library <id...>` to install verified catalog LUTs. Ingest performs immutable basename-preserving copies and checksum verification. A same-name file with different bytes is a conflict, not an overwrite opportunity.

Use `variant` when the requested asset is a separate version of an existing project. It creates a new project identity with copy-on-write inputs and reusable checksum-validated caches, retains exact edit/color decisions, and omits source previews and outputs. Use `new` for unrelated footage or a genuinely independent treatment.

Use `style --list` instead of inventing a font filename or assuming a cached binary exists. Applying a named preset materializes checksum-pinned catalog fonts, ingests each distinct selected role asset, and writes `config/style.json`; run `analyze` immediately afterward. Preserve a derivative's existing named preset by default. For styled copy on quiet Philippine scenic footage with no competing direction, recommend `philippines-island-editorial`. Treat all selected display/body/metadata fonts as used rights assets. Noto Sans Tagalog does not authorize generated or inferred Baybayin: use only user-supplied or independently verified text.

## Configuration records

After ingest, run `analyze`. Write each explicit camera/profile confirmation into `config/sources.json`, keyed by the source's project-relative path, then rerun `analyze`. Do not edit generated checksums in `analysis/sources.json`.

Declare every selected LUT in `config/luts.json` with its project-relative file, checksum, kind, profile ID where applicable, canonical `inputGamma` and `inputGamut`, descriptive input/output spaces, transform semantics, and default mix. A technical or combined LUT's canonical gamma and gamut must exactly match the corresponding confirmed source fields. Technical transforms use full strength. Creative mix is chosen in the edit, per shot.

Only one music file is accepted for deterministic beat analysis. Verify whether SRT timestamps are already reel-relative; do not assume source-relative captions will remain synchronized after editing.

## Rights

`brief.json` records the aggregate `rightsConfirmed` decision and the checksum fingerprint of the used asset set it covers. Present the inventory and ask explicitly: “Do you confirm that you own or have permission to use all listed assets in this output?” Include the question in the consolidated intake when rights are not already explicitly covered. Supplying paths, saying a track is licensed, or selecting OFL fonts does not itself supply the user's confirmation. Never infer ownership or edit either rights field manually. After the user's explicit response covers the exact current used set, run `npm run reel -- confirm-rights <name>`; this records the user's statement rather than asserting rights on their behalf. `status` treats the decision as stale when a referenced asset changes. It stays current when only an unused asset is ingested or the used set is otherwise unchanged. A variant preserves the confirmation only when the exact referenced fingerprint is unchanged; trust `status` and do not ask again in that case. If a later selection expands the used set beyond the response, ask only for confirmation of the newly uncovered assets.
