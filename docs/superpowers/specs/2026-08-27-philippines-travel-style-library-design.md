# Philippines Travel Style Library Design

## Status

Approved direction: a checksum-pinned local font cache, explicit role-based typography, reusable visual-style presets, and a separate stacked pull request based on `rafal/reel-derivative-variants`.

## Goal

Add a reusable, license-aware typography and visual-style library for Philippine travel reels and 1.91:1 carousel videos. A project must be able to apply a named preset reproducibly, stage every selected font explicitly, render subtle editorial overlays, and preserve the existing approval model.

The first presets should suit Bohol, island, landscape, food, street, and cultural travel footage without turning every Philippine story into the same tropical template.

## Current constraints

- The renderer currently selects the alphabetically first analyzed font and exposes it as one `ReelCustom` family for headings, subheadings, titles, and captions.
- Overlay colors, sizes, shadows, spacing, margins, and fades are hard-coded in `src/remotion/Reel.tsx`.
- `brief.style` accepts only `cinematic-minimal`.
- The reusable library has a tracked LUT catalog, but no font or style catalog.
- Font inputs already participate in ingest, source analysis, integrity checks, and rights confirmation. Render fingerprints and rights currently reference only the first renderable font.
- Photo exports contain no text-overlay model. The style library may be shared by future photo overlays, but adding photo copy is not part of this change.

## Architectural decision

Use tracked catalogs plus an ignored, checksum-verified local asset cache.

1. `library/font-catalog.json` records official source URLs, a pinned upstream revision, SHA-256 checksums, Open Font License metadata, supported roles, styles, weights, and scripts.
2. `library/style-catalog.json` records named presets and their resolved font-role assignments, palettes, text treatments, layout tokens, and motion tokens.
3. Downloaded binaries live under ignored `library/fonts/`. They are never trusted solely because a file with the expected name exists.
4. Applying a preset downloads missing assets to a temporary file, enforces an HTTPS allowlist and size cap, verifies SHA-256, atomically materializes the cache, ingests exact binaries into the project, and writes a project-local style snapshot.
5. `config/style.json` is the render authority for a project. It snapshots the chosen preset so later catalog changes cannot silently restyle an approved project.

This keeps Git lean, supports deterministic offline reuse after the first download, and follows the repository's existing catalog-plus-local-library model.

## Catalog contracts

### Font catalog

The tracked catalog has schema version `1.0.0` and a `fonts` array. Each asset records:

- a stable asset ID;
- family and PostScript-facing style metadata;
- weight as either a fixed numeric value or an inclusive variable-font range;
- supported roles: `display`, `body`, and/or `metadata`;
- supported scripts;
- an official Google Fonts source repository and pinned commit;
- an exact HTTPS download URL derived from that pinned commit;
- the local cache path;
- the SHA-256 checksum and maximum expected bytes;
- license identifier `OFL-1.1`, copyright text, and official license URL.

Initial assets:

| Asset ID | Family | Use | Scripts |
|---|---|---|---|
| `manrope-variable` | Manrope Variable | body and metadata; restrained modern headings | Latin, Cyrillic |
| `fraunces-variable` | Fraunces Variable | warm editorial display headings | Latin |
| `barlow-condensed-semibold` | Barlow Condensed SemiBold | compact field-note and location headings | Latin |
| `instrument-serif-regular` | Instrument Serif | quiet postcard/editorial display headings | Latin |
| `noto-sans-tagalog-regular` | Noto Sans Tagalog | optional verified Baybayin/Tagalog-script text | Tagalog |

Baybayin text is never generated or transliterated merely because the font is available. It requires user-supplied or independently verified copy.

### Style catalog

Each preset records:

- stable ID, name, description, and supported output profiles;
- `display`, `body`, and `metadata` font asset IDs plus weight/style selections;
- semantic colors rather than component-specific magic values;
- separate 9:16 and 1.91:1 type scales and safe-area measurements;
- overlay alignment, maximum width, scrim, shadow, tracking, line height, and spacing;
- fade duration in frames;
- fallback system-font stacks.

Initial semantic palette:

| Token | Value | Intended use |
|---|---:|---|
| `abacaWhite` | `#FFF6E8` | primary type |
| `deepPalm` | `#203B31` | dark fill and grounded accent |
| `lagoonTeal` | `#287A78` | water and cool accent |
| `mangoSunset` | `#E7A15B` | warm highlight |
| `mutedCoral` | `#C96859` | food, street, and human-detail accent |
| `cacaoBrown` | `#56382D` | Bohol/earth accent |
| `nightSea` | `#142B33` | dark background and scrim base |

Initial presets:

1. `philippines-island-editorial`
   - Fraunces display, Manrope body and metadata.
   - Abaca white type, mango-sunset accent, cacao-brown grounding.
   - Default recommendation for the Chocolate Hills and quiet scenic stories.
2. `philippines-field-notes`
   - Barlow Condensed SemiBold display, Manrope body and metadata.
   - Abaca white type with lagoon-teal and deep-palm accents.
   - Intended for routes, markets, boats, activities, and location-led sequences.
3. `philippines-postcard`
   - Instrument Serif display, Manrope body and metadata.
   - Abaca white type with muted-coral and night-sea accents.
   - Intended for slower, intimate, reflective, or food-focused stories.

Presets do not modify exposure, contrast, white balance, LUTs, or any other color-grade decision.

## Project style snapshot

Add a strict `StyleConfigSchema` for `config/style.json` with:

- `schemaVersion`;
- `presetId` and catalog version/fingerprint;
- explicit project-relative font paths for `display`, `body`, and `metadata`;
- internal renderer family names and requested weight/style;
- the resolved semantic palette;
- resolved overlay, layout, type-scale, and motion tokens for both supported output profiles.

New projects receive an explicit `cinematic-minimal` snapshot using system fallbacks. Applying a catalog preset replaces that snapshot atomically.

Legacy behavior:

- no style config and no font: use the current cinematic-minimal system fallback;
- no style config and exactly one renderable font: assign it to all three roles for compatibility;
- no style config and multiple renderable fonts: fail with a clear instruction to apply a style, eliminating ambiguous alphabetical selection.

## Command surface

Add one command family:

```text
npm run reel -- style --list
npm run reel -- style <reel-name> --apply philippines-island-editorial
```

`style --list` is read-only and shows presets, roles, cached/download-needed state, licenses, and source families.

`style <reel> --apply <id>`:

1. validates the project and preset;
2. resolves every font asset required by the preset;
3. reuses only exact valid cache entries;
4. downloads missing entries from pinned official URLs into temporary files;
5. verifies size and SHA-256 before atomically placing cache files;
6. ingests the binaries without overwriting conflicting project inputs;
7. writes the complete `config/style.json` snapshot atomically;
8. reports that source analysis must run before the next preview.

A failed download, checksum mismatch, input conflict, or config write leaves the existing project style unchanged. Successfully downloaded cache files may remain available for a retry.

## Renderer integration

Replace the single optional `fontUrl` prop with explicit role assets while retaining a legacy adapter for old render-stage records:

- `displayFont` for card headings and timeline titles;
- `bodyFont` for card subheadings and captions;
- `metadataFont` for small labels and future location/date treatments.

Each staged role records URL, internal family, weight, and style. Duplicate roles pointing to the same font binary are staged and loaded once. The renderer waits for every distinct custom font to load before rendering.

CSS uses role-specific internal families such as `ReelDisplay`, `ReelBody`, and `ReelMetadata`; catalog family names never become executable CSS fragments.

The `philippines-island-editorial` overlay treatment is intentionally subtle:

- lower-left by default;
- maximum text width near 62% of the frame;
- horizontal safe margin near 5% and bottom margin near 7.5%;
- carousel display text approximately 46–52 px and body text 26–30 px at 1910×1000;
- profile-specific larger values for 1080×1920;
- short 8-frame fade in and out at 30 fps;
- no bounce, typewriter, zoom, or spring motion;
- soft dark shadow and bounded bottom scrim only when required for contrast;
- Abaca white body text with restrained semantic accent use.

All values come from the project style snapshot rather than component literals.

## Fingerprints, rights, and approvals

- Every explicitly selected font path becomes a referenced render source.
- Rights confirmation includes every selected font checksum, not every font merely present in `input/fonts`.
- Style configuration and selected font identities become part of preview/master/delivery render fingerprints.
- A style or typography change makes the rough preview and edit approval stale.
- A style-only change does not alter the color hash. Once the new rough preview is approved, exact current color approval and reviewed stills may remain reusable.
- Adding or replacing font files requires fresh source analysis before rendering or rights confirmation.
- Preset installation does not introduce a new approval gate. Typography is reviewed through the existing exact rough-cut approval.

## Skill behavior

Update `create-social-reel` so future runs:

- inspect `style --list` instead of inventing font filenames or assuming a cached asset exists;
- recommend `philippines-island-editorial` for quiet Philippine scenic footage when the user requests styled copy and gives no competing direction;
- preserve a user-selected preset across exact derivatives;
- treat typography changes as editorial, not color, invalidators;
- mention the chosen preset and role pairing in the rough-review handoff;
- never use Baybayin without verified text;
- keep photo-only exports visually compatible with the chosen palette even though photo text overlays remain out of scope.

No new user approval stop is added beyond the existing reel workflow gates.

## Failure handling and security

- Only catalog-declared HTTPS hosts and pinned paths may be downloaded.
- Redirects must remain HTTPS and on the allowlist.
- Downloads have a fixed byte cap and timeout.
- Files are written to unique temporary paths, verified, then atomically renamed.
- A cache file with the right name but wrong bytes is rejected and replaced only after a valid download succeeds.
- Project-relative paths use the repository's traversal-safe resolver.
- Font data is never executed as code.
- Catalog parsing is strict; unknown fields and unsupported roles, profiles, colors, or weight ranges fail early.

## Testing and verification

Implementation follows test-driven development. Required coverage includes:

- strict font and style catalog schemas;
- pinned URL, checksum, byte-cap, redirect, and atomic-cache behavior;
- exact cache reuse and corrupted-cache recovery;
- conflict-safe project ingest and atomic style application;
- explicit three-role staging, deduplication, and font loading;
- legacy zero-font, one-font, and ambiguous multi-font behavior;
- role-specific renderer CSS and both output-profile token sets;
- all selected fonts in render and rights fingerprints;
- rough approval invalidation with color approval preservation for style-only changes;
- CLI list/apply behavior and command registry coverage;
- doctor validation of tracked catalogs without failing merely because optional fonts have not yet been downloaded;
- `create-social-reel` skill validation and a Philippines styled-carousel behavior evaluation;
- the complete typecheck, unit/integration, E2E, and doctor verifier.

## Non-goals

- Do not automatically color-grade footage based on a style preset.
- Do not infer or fabricate Baybayin copy.
- Do not download mutable `main`/`latest` font URLs.
- Do not commit font binaries to Git in this design.
- Do not add arbitrary user-authored remote URLs.
- Do not add photo text overlays, logo generation, stickers, transitions, or new editorial approval gates.
- Do not silently choose among multiple unassigned fonts.

