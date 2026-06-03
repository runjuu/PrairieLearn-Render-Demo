import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prairieLearnDir = path.join(root, 'PrairieLearn');
const renderScript = path.join(
  prairieLearnDir,
  'apps',
  'prairielearn',
  'dist',
  'cli',
  'preview-render.js',
);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(prairieLearnDir))) {
  throw new Error(
    'Missing PrairieLearn submodule. Run: git submodule update --init --recursive',
  );
}

await run('corepack', ['enable']);
await run('yarn', ['install'], { cwd: prairieLearnDir });
await run('make', ['python-deps-core'], { cwd: prairieLearnDir });
await run(
  'yarn',
  [
    'workspaces',
    'foreach',
    '-Rp',
    '--topological-dev',
    '--from',
    '@prairielearn/prairielearn',
    'run',
    'build',
  ],
  { cwd: prairieLearnDir },
);

if (!(await exists(renderScript))) {
  throw new Error(`PrairieLearn preview renderer was not built: ${renderScript}`);
}

console.log(`PrairieLearn preview renderer ready: ${renderScript}`);
