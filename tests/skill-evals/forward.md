# Skill forward-test results

Seven fresh-context, read-only agents were instructed to use `.agents/skills/create-social-reel/SKILL.md` and the references it routed for the corresponding cases in `cases.json`. None modified the repository.

| Case | Result | Evidence of improvement over no-skill control |
| --- | --- | --- |
| DJI start-to-finish | Pass | Followed the exact command order; required explicit DJI model/gamma/gamut and LUT semantics; defined the watermarked proxy boundary; stopped before both approval commands; covered rights, stabilization fallback, render fingerprints, and final deliverables. |
| Mixed DJI/Sony | Pass | Required source-specific profiles, distinguished S-Gamut3.Cine from S-Gamut3, kept the ambiguous HDR LUT blocked, enforced one normalizer, and named both approval checkpoints and final QC sequence. |
| Creative LUT selection | Pass | Refused filename-based ranking, required actual normalized frame comparisons and a neutral option, treated the PDF ranges as guidance rather than presets, and left color approval with the user. |
| Music/captions/stabilization | Pass | Covered immutable ingest, beat/onset analysis, SRT timing and safe-area review, per-shot stabilization with approved fallback, exactly two mandatory pauses, user-owned rights, and full delivery review. |
| Stale approvals and QC | Pass | Correctly required a new preview and both approvals after trim/crop plus a new color review after blend changes; cited reference-frame checksums and target-specific render fingerprints; rejected same-name files as freshness evidence. |
| Explicit rights persistence | Pass | Persisted the user's explicit decision as `rightsConfirmed: true` after inventory, did not ask again for the unchanged set, and reset the aggregate gate before using newly introduced material. |
| Proxy-only incomplete intake | Pass | Declared the named blocker and first blocked command, kept the rough visibly watermarked, revisited only those facts with rough review, blocked graded stills, and required normalized-preview regeneration and reapproval after the facts changed its fingerprint. |

All seven cases covered their `mustCover` expectations. Compared with the controls, the skill removed speculative LUT naming, made the ready and proxy-only interaction paths explicit, persisted user-confirmed rights without a later repeat question, tied approval commands to exact user-reviewed artifacts, and incorporated the engine repairs for per-shot fallback, reviewed-frame checksums, and current-render fingerprints.
