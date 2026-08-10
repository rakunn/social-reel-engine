import path from 'node:path';

const REEL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const assertSafeReelName = (value: string): string => {
  if (!REEL_NAME.test(value)) {
    throw new Error(
      `Invalid reel name "${value}". Use lowercase letters, numbers, and single hyphens only.`,
    );
  }
  return value;
};

export const resolveProjectPath = (engineRoot: string, reelName: string): string => {
  const safeName = assertSafeReelName(reelName);
  const projectsRoot = path.resolve(engineRoot, 'projects');
  const projectPath = path.resolve(projectsRoot, safeName);
  if (!projectPath.startsWith(`${projectsRoot}${path.sep}`)) {
    throw new Error('Resolved reel path escaped the projects directory');
  }
  return projectPath;
};

export const resolveInside = (root: string, relativePath: string): string => {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Expected a relative path, received "${relativePath}"`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path "${relativePath}" escapes its allowed root`);
  }
  return resolved;
};
