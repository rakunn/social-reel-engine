import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {exitCodeForRenderError, RenderInterruptedError} from '../../src/render/errors';

const writeJsonFailure = new Error('operation failure record could not be written');
let failFailureRecord = false;

vi.mock('../../src/core/json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/json')>();
  return {
    ...actual,
    writeJson: vi.fn(async (filePath: string, value: unknown) => {
      if (
        failFailureRecord &&
        filePath.endsWith('/analysis/operation.json') &&
        typeof value === 'object' &&
        value !== null &&
        'state' in value &&
        value.state === 'failed'
      ) {
        throw writeJsonFailure;
      }
      return await actual.writeJson(filePath, value);
    }),
  };
});

import {runMediaOperation} from '../../src/project/operation';

const temporaryProjects: string[] = [];

beforeEach(() => {
  failFailureRecord = false;
});

afterEach(async () => {
  await Promise.all(
    temporaryProjects
      .splice(0)
      .map(async (projectPath) => await rm(projectPath, {recursive: true, force: true})),
  );
});

describe('media operation failure finalization', () => {
  it('preserves an interrupt when failure-state finalization also fails', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-operation-finalization-'));
    temporaryProjects.push(projectPath);
    const interruption = new RenderInterruptedError('SIGINT');

    let thrown: unknown;
    try {
      await runMediaOperation(projectPath, 'proxy', async () => {
        failFailureRecord = true;
        throw interruption;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([interruption, writeJsonFailure]);
    expect(exitCodeForRenderError(thrown)).toBe(130);
  });
});
