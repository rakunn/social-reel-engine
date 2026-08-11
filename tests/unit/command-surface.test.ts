import {randomUUID} from 'node:crypto';
import {access, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {COMMAND_NAMES} from '../../src/commands/registry';
import {createCli} from '../../src/cli';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('rejects an unknown project before a tracked command creates operation state', async () => {
    const reelName = `missing-${randomUUID().replaceAll('-', '')}`;
    const projectPath = path.join(repositoryRoot, 'projects', reelName);
    try {
      await expect(
        createCli().parseAsync(['node', 'reel', 'analyze', reelName]),
      ).rejects.toThrow(/project.*does not exist|does not exist.*project/i);
      await expect(access(projectPath)).rejects.toThrow();
    } finally {
      await rm(projectPath, {recursive: true, force: true});
    }
  });
});
