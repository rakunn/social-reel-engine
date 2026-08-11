import {describe, expect, it} from 'vitest';
import {COMMAND_NAMES} from '../../src/commands/registry';
import {createCli} from '../../src/cli';

describe('stable command interface', () => {
  it('exposes every documented reel command in order', () => {
    expect(COMMAND_NAMES).toEqual([
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
    ]);
    expect(createCli().commands.map((command) => command.name())).toEqual(COMMAND_NAMES);
  });
});
