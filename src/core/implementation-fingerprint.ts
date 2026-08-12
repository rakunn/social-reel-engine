import {builtinModules} from 'node:module';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {preProcessFile} from 'typescript';
import {hashValue} from './hash';

export type ImplementationFingerprintScope =
  | 'proxy'
  | 'stabilize'
  | 'grade'
  | 'preview'
  | 'master'
  | 'delivery';

export type ImplementationFingerprintOptions = {
  engineRoot?: string;
};

type ScopeDefinition = {
  recursiveEntrypoints: readonly string[];
  shallowFiles?: readonly string[];
  excludedModules?: readonly string[];
};

const defaultEngineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fingerprintImplementationPath = 'src/core/implementation-fingerprint.ts';

const rendererEntrypoints = [
  'src/remotion/index.ts',
  'src/render/remotion-worker.ts',
] as const;
const renderShallowFiles = ['src/render/remotion.ts', 'remotion.config.ts'] as const;

const scopeDefinitions: Record<ImplementationFingerprintScope, ScopeDefinition> = {
  proxy: {
    recursiveEntrypoints: ['src/media/proxy.ts'],
  },
  stabilize: {
    recursiveEntrypoints: ['src/media/preview-stabilize.ts'],
  },
  grade: {
    recursiveEntrypoints: ['src/media/grade.ts'],
    excludedModules: ['src/media/preview-stabilize.ts'],
  },
  preview: {
    recursiveEntrypoints: [
      'src/media/proxy.ts',
      'src/media/preview-stabilize.ts',
      'src/render/stage.ts',
      ...rendererEntrypoints,
    ],
    shallowFiles: renderShallowFiles,
    excludedModules: ['src/media/grade.ts'],
  },
  master: {
    recursiveEntrypoints: [
      'src/media/grade.ts',
      'src/render/stage.ts',
      ...rendererEntrypoints,
    ],
    shallowFiles: renderShallowFiles,
    excludedModules: [
      'src/media/proxy.ts',
      'src/media/preview-stabilize.ts',
    ],
  },
  delivery: {
    recursiveEntrypoints: [
      'src/media/grade.ts',
      'src/render/stage.ts',
      ...rendererEntrypoints,
      'src/media/qc.ts',
      'src/media/ffmpeg.ts',
      'src/media/atomic-output.ts',
    ],
    shallowFiles: renderShallowFiles,
    excludedModules: [
      'src/media/proxy.ts',
      'src/media/preview-stabilize.ts',
    ],
  },
};

const normalizeRelativePath = (filePath: string): string =>
  filePath.split(path.sep).join('/');

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const relativeModuleCandidates = (importer: string, specifier: string): string[] => {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(unresolved);
  const candidates = extension
    ? [
        unresolved,
        ...(extension === '.js'
          ? [
              `${unresolved.slice(0, -extension.length)}.ts`,
              `${unresolved.slice(0, -extension.length)}.tsx`,
            ]
          : []),
      ]
    : [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.json`,
        path.join(unresolved, 'index.ts'),
        path.join(unresolved, 'index.tsx'),
      ];
  return [...new Set(candidates)];
};

const importedSpecifiers = (content: string): string[] =>
  preProcessFile(content, true, true).importedFiles.map((entry) => entry.fileName);

const packageNameFor = (specifier: string): string | null => {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    builtinModules.includes(specifier)
  ) {
    return null;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const collectScopeFiles = async (
  engineRoot: string,
  definition: ScopeDefinition,
): Promise<{files: Map<string, string>; packages: Set<string>}> => {
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const excluded = new Set([
    fingerprintImplementationPath,
    ...(definition.excludedModules ?? []),
  ]);

  const readTrackedFile = async (relativePath: string): Promise<string> => {
    const normalized = normalizeRelativePath(relativePath);
    const content = await readFile(path.join(engineRoot, normalized), 'utf8');
    files.set(normalized, content);
    return content;
  };

  const visit = async (relativePath: string): Promise<void> => {
    const normalized = normalizeRelativePath(relativePath);
    if (files.has(normalized) || excluded.has(normalized)) return;
    const absolutePath = path.join(engineRoot, normalized);
    const content = await readTrackedFile(normalized);
    for (const specifier of importedSpecifiers(content)) {
      const packageName = packageNameFor(specifier);
      if (packageName !== null) {
        packages.add(packageName);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const candidates = relativeModuleCandidates(absolutePath, specifier);
      const resolved = await candidates.reduce<Promise<string | null>>(
        async (previous, candidate) =>
          (await previous) ?? ((await fileExists(candidate)) ? candidate : null),
        Promise.resolve(null),
      );
      if (resolved === null) {
        throw new Error(`Could not resolve implementation dependency ${specifier} from ${normalized}`);
      }
      await visit(normalizeRelativePath(path.relative(engineRoot, resolved)));
    }
  };

  for (const entrypoint of definition.recursiveEntrypoints) {
    await visit(entrypoint);
  }
  for (const shallowFile of definition.shallowFiles ?? []) {
    const normalized = normalizeRelativePath(shallowFile);
    if (files.has(normalized)) continue;
    const content = await readTrackedFile(normalized);
    for (const specifier of importedSpecifiers(content)) {
      const packageName = packageNameFor(specifier);
      if (packageName !== null) packages.add(packageName);
    }
  }
  return {files, packages};
};

type PackageManifest = {
  engines?: {node?: string};
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const uncachedImplementationFingerprint = async (
  scope: ImplementationFingerprintScope,
  engineRoot: string,
): Promise<string> => {
  const definition = scopeDefinitions[scope];
  const [{files, packages}, packageManifestRaw] = await Promise.all([
    collectScopeFiles(engineRoot, definition),
    readFile(path.join(engineRoot, 'package.json'), 'utf8'),
  ]);
  const packageManifest = JSON.parse(packageManifestRaw) as PackageManifest;
  const declaredPackages = {
    ...packageManifest.devDependencies,
    ...packageManifest.optionalDependencies,
    ...packageManifest.dependencies,
  };
  return hashValue({
    contractVersion: '1.0.0',
    scope,
    node: packageManifest.engines?.node ?? null,
    packages: Object.fromEntries(
      [...packages]
        .sort((left, right) => left.localeCompare(right))
        .map((packageName) => [packageName, declaredPackages[packageName] ?? 'transitive']),
    ),
    files: [...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, content]) => ({file, checksumSha256: hashValue(content)})),
  });
};

const defaultFingerprintPromises = new Map<
  ImplementationFingerprintScope,
  Promise<string>
>();

export const implementationFingerprint = async (
  scope: ImplementationFingerprintScope,
  options: ImplementationFingerprintOptions = {},
): Promise<string> => {
  const engineRoot = options.engineRoot ?? defaultEngineRoot;
  if (options.engineRoot !== undefined) {
    return await uncachedImplementationFingerprint(scope, engineRoot);
  }
  let pending = defaultFingerprintPromises.get(scope);
  if (pending === undefined) {
    pending = uncachedImplementationFingerprint(scope, engineRoot);
    defaultFingerprintPromises.set(scope, pending);
  }
  return await pending;
};
