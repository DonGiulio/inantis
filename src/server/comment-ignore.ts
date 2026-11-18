import { execFile } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Check an exact review Markdown path against Git's ignore rules and index. */
export async function getCommentIgnoreStatus(root: string, reviewPath: string): Promise<{ path: string; ignored: boolean; tracked: boolean }> {
  const path = relative(resolve(root), resolve(root, reviewPath));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    // A caller explicitly selected an output outside the repository; Git's
    // ignore rules and index for this repository cannot apply to it.
    return { path: resolve(root, reviewPath), ignored: false, tracked: false };
  }

  async function matches(args: string[]): Promise<boolean> {
    try {
      await exec('git', args, { cwd: root });
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) return false;
      throw error;
    }
  }

  const [ignored, tracked] = await Promise.all([
    matches(['check-ignore', '--no-index', '--quiet', '--', path]),
    matches(['ls-files', '--error-unmatch', '--', `:(literal)${path}`]),
  ]);
  return { path, ignored, tracked };
}
