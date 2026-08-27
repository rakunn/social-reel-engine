# Color safety

## Required chain

For each shot, enforce this order:

```text
pre-transform exposure / white balance / tint
→ exactly one technical normalization LUT
→ at most one optional creative LUT with explicit blend
→ Rec.709 output
```

A combined LUT with `normalization-and-look` semantics replaces both LUT stages. It must never coexist with a technical LUT or a second creative LUT.

## Confirmation standard

Treat the following as unconfirmed until the user states them or reliable supplied metadata proves them:

- camera model;
- gamma/log curve;
- gamut;
- LUT kind and transform direction;
- input and output color spaces;
- whether an editor or source was already normalized.

Do not infer these from a filename, extension, camera brand, flat appearance, or the fact that a file is called “conversion,” “HDR,” or “709.” A source with missing confirmation may receive only the visibly watermarked flat-log proxy. It cannot receive graded stills or a final export.

## Supplied local catalog

Use `npm run reel -- ingest <name> --list-library` as the source of truth for IDs and checksums. The current declared mappings include:

- DJI Mini 4 Pro D-Log M → Rec.709;
- Sony S-Log3/S-Gamut3.Cine → Rec.709;
- Sony S-Log3/S-Gamut3 → Rec.709.

For Sony, “S-Log3” does not identify the gamut. Require the user to distinguish S-Gamut3.Cine from S-Gamut3 before choosing between the supplied technical transforms.

Technical/combined catalog records carry separate canonical `inputGamma` and `inputGamut` fields. The engine compares both to the source confirmation, in addition to profile ID and any declared camera model; a contradictory label such as HLG/BT.2020 with a D-Log M transform is not compatible even if someone reuses the profile ID.

`HDR CONVERSION LUT.cube` is intentionally unclassified and blocked. Its name does not establish direction, transfer function, gamut, mastering assumptions, or whether it is technical, creative, or combined. Do not install or apply it until those semantics are supplied and recorded.

## Creative LUT policy

The supplied Szatrasie guide establishes general technique, not a shot-to-look prescription: correct first, normalize log footage, apply a creative look after normalization, and tune intensity to the footage. Its general guidance mentions approximately 20–80% intensity, with a separate VN example around 60–90%; neither is a mandatory value.

Do not select or rank Polish-named looks by translating their filenames. Compare actual rendered, technically normalized reference frames on representative daylight, shadow, sky, and skin/neutral content when present. Start with a restrained mix only as a proposal, retain a neutral option, and bind the selected values to color approval.

When creating a derivative from the same byte-identical sources and selections, keep approved per-shot exposure, white balance, tint, LUT choices, blends, and treatments by default. This is exact dependency reuse, not automatic grading: re-evaluate when the source, selected interval, crop, stabilization, output color dimensions, LUT declaration/bytes, or creative intent changes, and never copy those corrections to unrelated footage merely because it shares a log profile.

## Review failures

Regenerate or reject a grade when reference frames show unintended clipping, channel imbalance, crushed shadows, blown highlights, inconsistent neutral/skin rendering, a double-transform look, or excessive creative intensity. Automated output tags do not substitute for visual color review on a suitable display.
