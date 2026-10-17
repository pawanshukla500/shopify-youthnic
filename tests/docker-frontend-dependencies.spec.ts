import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
const frontendStage = dockerfile.split('RUN cd frontend && npm run build')[0];

/** Walk type-only imports too: tsc needs them even though Vite strips them. */
function sharedDependencies(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const content = readFileSync(file, 'utf8');
  for (const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const path = resolve(dirname(file), match[1]);
    const dependency = [`${path}.ts`, resolve(path, 'index.ts')].find(existsSync);
    if (dependency) sharedDependencies(dependency, seen);
  }
  return seen;
}

describe('Docker frontend shared dependencies', () => {
  it('copies shared helpers and their transitive type imports before the frontend build', () => {
    const copies = [...frontendStage.matchAll(/^COPY\s+(\S+)\s+(\S+)/gm)]
      .map((match) => resolve(root, match[1]));
    for (const helper of ['order-tabs.ts', 'order-financials.ts']) {
      for (const dependency of sharedDependencies(resolve(root, 'src/modules/orders', helper))) {
        expect(copies.some((source) => source === dependency || dependency.startsWith(source + '/')
          || dependency.startsWith(source + '\\')), `Missing Docker frontend dependency: ${dependency}`).toBe(true);
      }
    }
  });

  it('validates the actual Docker builder in PR checks', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/pull-request.yml'), 'utf8');
    expect(workflow).toContain('docker build --target builder');
  });
});
