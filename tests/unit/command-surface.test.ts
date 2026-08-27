import {randomUUID} from 'node:crypto';
import {access, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {COMMAND_NAMES} from '../../src/commands/registry';
import {createCli} from '../../src/cli';
import {completeMediaOperation, beginMediaOperation} from '../../src/project/operation';
import {createReelProject} from '../../src/project/workspace';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('stable command interface', () => {
  it('exposes every documented reel command in order', () => {
    expect(COMMAND_NAMES).toEqual([
      'doctor',
      'new',
      'variant',
      'ingest',
      'style',
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
      'render-carousel',
      'qc',
      'qc-carousel',
      'photos',
      'approve-photos',
      'status',
    ]);
    expect(createCli().commands.map((command) => command.name())).toEqual(COMMAND_NAMES);
  });

  it('offers an explicit 1.91:1 carousel project format', () => {
    const command = createCli().commands.find((candidate) => candidate.name() === 'new');
    const format = command?.options.find((option) => option.long === '--format');
    expect(format?.argChoices).toEqual(['reel-9:16', 'carousel-1.91:1']);
    expect(format?.defaultValue).toBe('reel-9:16');
  });

  it('offers reusable style listing and project application modes', () => {
    const command = createCli().commands.find((candidate) => candidate.name() === 'style');
    expect(command?.options.map((option) => option.long)).toEqual(['--list', '--apply']);
    expect(command?.registeredArguments[0].required).toBe(false);
  });

  it('rejects an unknown project before applying a style', async () => {
    const reelName = `missing-style-${randomUUID().replaceAll('-', '')}`;
    const projectPath = path.join(repositoryRoot, 'projects', reelName);
    await expect(
      createCli().parseAsync([
        'node',
        'reel',
        'style',
        reelName,
        '--apply',
        'philippines-island-editorial',
      ]),
    ).rejects.toThrow(/project.*does not exist|does not exist.*project/i);
    await expect(access(projectPath)).rejects.toThrow();
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

  it('does not change photo configuration when the media lock is already held', async () => {
    const reelName = `photo-lock-${randomUUID().replaceAll('-', '')}`;
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      reelName,
      title: 'Photo Lock Test',
    });
    const configPath = path.join(projectPath, 'config/photos.json');
    const before = await readFile(configPath, 'utf8');
    const active = await beginMediaOperation(projectPath, 'grade', {phase: 'grading-selected-clips'});
    try {
      await expect(
        createCli().parseAsync([
          'node',
          'reel',
          'photos',
          reelName,
          '--aspect',
          '9:16',
          '--count',
          '1',
        ]),
      ).rejects.toThrow(/media operation.*active|active.*media operation/i);
      expect(await readFile(configPath, 'utf8')).toBe(before);
    } finally {
      if (active.id) await completeMediaOperation(projectPath, active.id);
      await rm(projectPath, {recursive: true, force: true});
    }
  });

  it('does not approve photo reframes while another media operation holds the lock', async () => {
    const reelName = `photo-approval-lock-${randomUUID().replaceAll('-', '')}`;
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      reelName,
      title: 'Photo Approval Lock Test',
    });
    const approvalPath = path.join(projectPath, 'analysis/photo-approval.json');
    const active = await beginMediaOperation(projectPath, 'photos', {
      phase: 'creating-photo-candidates',
    });
    try {
      await expect(
        createCli().parseAsync(['node', 'reel', 'approve-photos', reelName]),
      ).rejects.toThrow(/media operation.*active|active.*media operation/i);
      await expect(access(approvalPath)).rejects.toThrow();
    } finally {
      if (active.id) await completeMediaOperation(projectPath, active.id);
      await rm(projectPath, {recursive: true, force: true});
    }
  });
});
