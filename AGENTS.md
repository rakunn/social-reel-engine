# Repository Instructions

## Social reel workflow

For routine reel creation, editing, grading, previewing, rendering, or QC, use the repository's `create-social-reel` skill as the sole orchestration workflow.

- Do not invoke `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:executing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`, or `superpowers:finishing-a-development-branch` for routine reel production.
- Do not ask the user to approve specs or plans, or to choose an agent strategy, execution mode, checkout, worktree, branch, or commit workflow. Make those internal process decisions autonomously and safely.
- Consolidate all currently knowable factual, rights, and editorial blockers into one intake request. Use reasonable stated defaults for non-blocking creative choices.
- After explicit user rights confirmation, run `confirm-rights` to bind that decision to the exact current used asset checksums in `brief.json`; never infer or manually edit the confirmation. Trust `status` to detect a changed referenced set and request only the missing confirmation.
- When intake is complete, stop only for the exact rough-cut and color approvals required by `create-social-reel`. A user-requested non-9:16 photo package may add the skill's checksum-bound photo-reframe approval after final video QC; do not introduce any other approval stop. When a disclosed source-profile or transform fact remains unresolved, use the skill's proxy-only path: revisit that fact with the rough review, and regenerate and reapprove the rough if resolving it changes the preview.
- After a concrete technical failure, use `superpowers:systematic-debugging` internally when useful without adding user approval gates.
- When the user requests changes to the reel engine or other repository source code, use the normal development workflow and any applicable engineering skills.
