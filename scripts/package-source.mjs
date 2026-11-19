// Zips the committed source for AMO review: everything git tracks at HEAD, nothing generated.
// Refuses to run with uncommitted changes, so the zip always matches a commit you can rebuild from.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

if (git('status', '--porcelain')) {
  console.error('Commit or stash your changes first. The source package is built from HEAD.');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'));
const out = resolve(root, 'artifacts', `deja-vu-${version}-source.zip`);
mkdirSync(dirname(out), { recursive: true });
git('archive', '--format=zip', '--prefix=deja-vu/', '-o', out, 'HEAD');
console.log(`Source for ${git('rev-parse', '--short', 'HEAD')} written to ${out}`);
