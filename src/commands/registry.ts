export const COMMAND_NAMES = [
  'doctor',
  'new',
  'ingest',
  'analyze',
  'proxy',
  'beats',
  'validate-edit',
  'preview',
  'approve-edit',
  'grade-stills',
  'approve-color',
  'confirm-rights',
  'grade',
  'render',
  'qc',
  'status',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
