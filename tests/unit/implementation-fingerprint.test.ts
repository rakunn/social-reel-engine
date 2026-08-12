import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  implementationFingerprint,
  type ImplementationFingerprintScope,
} from '../../src/core/implementation-fingerprint';

const roots: string[] = [];

const writeFixtureFile = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, content, 'utf8');
};

const makeEngineFixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-build-fingerprint-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      dependencies: {'@remotion/renderer': '4.0.507'},
      devDependencies: {typescript: '5.9.3'},
    }),
    'package-lock.json': JSON.stringify({
      name: 'fingerprint-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          dependencies: {'@remotion/renderer': '4.0.507'},
          devDependencies: {typescript: '5.9.3'},
        },
        'node_modules/@remotion/renderer': {
          version: '4.0.507',
          integrity: 'sha512-renderer-v1',
          dependencies: {'render-runtime-child': '1.0.0'},
        },
        'node_modules/render-runtime-child': {
          version: '1.0.0',
          integrity: 'sha512-child-v1',
        },
        'node_modules/unrelated-package': {
          version: '1.0.0',
          integrity: 'sha512-unrelated-v1',
        },
      },
    }),
    'remotion.config.ts': "export const config = 'remotion-config-v1';\n",
    'src/cli.ts': "export const cli = 'v1';\n",
    'src/media/proxy.ts': "import './proxy-helper';\nexport const proxy = 'v1';\n",
    'src/media/proxy-helper.ts': "export const proxyHelper = 'v1';\n",
    'src/media/preview-stabilize.ts':
      "import './stabilize-helper';\nexport const stabilize = 'v1';\n",
    'src/media/stabilize-helper.ts': "export const stabilizeHelper = 'v1';\n",
    'src/media/grade.ts': "import './grade-helper';\nexport const grade = 'v1';\n",
    'src/media/grade-helper.ts': "export const gradeHelper = 'v1';\n",
    'src/media/qc.ts': "export const loudnessParser = 'v1';\n",
    'src/media/ffmpeg.ts': "import './process';\nexport const ffmpeg = 'v1';\n",
    'src/media/process.ts': "export const processRunner = 'v1';\n",
    'src/media/atomic-output.ts': "export const atomicOutput = 'v1';\n",
    'src/render/stage.ts': [
      "import '../media/proxy';",
      "import '../media/preview-stabilize';",
      "import '../media/grade';",
      "import './stage-helper';",
      "export const stage = 'v1';",
      '',
    ].join('\n'),
    'src/render/stage-helper.ts': "export const stageHelper = 'v1';\n",
    'src/render/remotion-worker.ts': [
      "import '@remotion/renderer';",
      "import './policy';",
      "export const worker = 'v1';",
      '',
    ].join('\n'),
    'src/render/policy.ts': "export const policy = 'v1';\n",
    'src/render/remotion.ts': "import './policy';\nexport const orchestration = 'v1';\n",
    'src/remotion/index.ts': "import './Reel';\nexport const entry = 'v1';\n",
    'src/remotion/Reel.tsx': "export const Reel = () => 'reel-v1';\n",
  };
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      await writeFixtureFile(root, relativePath, content);
    }),
  );
  return root;
};

const fingerprints = async (
  root: string,
): Promise<Record<ImplementationFingerprintScope, string>> => {
  const scopes: ImplementationFingerprintScope[] = [
    'proxy',
    'stabilize',
    'grade',
    'preview',
    'master',
    'delivery',
  ];
  return Object.fromEntries(
    await Promise.all(
      scopes.map(async (scope) => [
        scope,
        await implementationFingerprint(scope, {engineRoot: root}),
      ]),
    ),
  ) as Record<ImplementationFingerprintScope, string>;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {recursive: true})));
});

describe('stage-scoped implementation fingerprints', () => {
  it('ignores unrelated CLI changes', async () => {
    const root = await makeEngineFixture();
    const before = await fingerprints(root);

    await writeFixtureFile(root, 'src/cli.ts', "export const cli = 'v2';\n");

    expect(await fingerprints(root)).toEqual(before);
  });

  it('invalidates only proxy-derived preview work for a proxy implementation change', async () => {
    const root = await makeEngineFixture();
    const before = await fingerprints(root);

    await writeFixtureFile(
      root,
      'src/media/proxy-helper.ts',
      "export const proxyHelper = 'v2';\n",
    );
    const after = await fingerprints(root);

    expect(after.proxy).not.toBe(before.proxy);
    expect(after.preview).not.toBe(before.preview);
    expect(after.stabilize).toBe(before.stabilize);
    expect(after.grade).toBe(before.grade);
    expect(after.master).toBe(before.master);
    expect(after.delivery).toBe(before.delivery);
  });

  it('cascades grade and renderer changes only to their dependent outputs', async () => {
    const root = await makeEngineFixture();
    const initial = await fingerprints(root);

    await writeFixtureFile(
      root,
      'src/media/grade-helper.ts',
      "export const gradeHelper = 'v2';\n",
    );
    const afterGrade = await fingerprints(root);
    expect(afterGrade.grade).not.toBe(initial.grade);
    expect(afterGrade.master).not.toBe(initial.master);
    expect(afterGrade.delivery).not.toBe(initial.delivery);
    expect(afterGrade.proxy).toBe(initial.proxy);
    expect(afterGrade.preview).toBe(initial.preview);

    await writeFixtureFile(root, 'src/remotion/Reel.tsx', "export const Reel = () => 'v2';\n");
    const afterRenderer = await fingerprints(root);
    expect(afterRenderer.preview).not.toBe(afterGrade.preview);
    expect(afterRenderer.master).not.toBe(afterGrade.master);
    expect(afterRenderer.delivery).not.toBe(afterGrade.delivery);
    expect(afterRenderer.proxy).toBe(afterGrade.proxy);
    expect(afterRenderer.grade).toBe(afterGrade.grade);
  });

  it('tracks the relevant resolved lockfile closure without invalidating unrelated stages', async () => {
    const root = await makeEngineFixture();
    const initial = await fingerprints(root);
    const lockPath = path.join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      packages: Record<string, Record<string, unknown>>;
    };

    lock.packages['node_modules/unrelated-package'] = {
      version: '2.0.0',
      integrity: 'sha512-unrelated-v2',
    };
    await writeFixtureFile(root, 'package-lock.json', JSON.stringify(lock));
    expect(await fingerprints(root)).toEqual(initial);

    lock.packages['node_modules/render-runtime-child'] = {
      version: '1.1.0',
      integrity: 'sha512-child-v2',
    };
    await writeFixtureFile(root, 'package-lock.json', JSON.stringify(lock));
    const afterResolvedDependencyChange = await fingerprints(root);

    expect(afterResolvedDependencyChange.preview).not.toBe(initial.preview);
    expect(afterResolvedDependencyChange.master).not.toBe(initial.master);
    expect(afterResolvedDependencyChange.delivery).not.toBe(initial.delivery);
    expect(afterResolvedDependencyChange.proxy).toBe(initial.proxy);
    expect(afterResolvedDependencyChange.stabilize).toBe(initial.stabilize);
    expect(afterResolvedDependencyChange.grade).toBe(initial.grade);
  });
});
