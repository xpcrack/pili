import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

function routePathFromFile(file: string) {
  return `/${relative(resolve('app/api'), file)}`
    .replaceAll('\\', '/')
    .replace(/\/route\.ts$/, '')
    .replace(/\[([^\]]+)\]/g, ':$1');
}

function listRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listRouteFiles(path);
    return entry.isFile() && entry.name === 'route.ts' ? [path] : [];
  });
}

function main() {
  const adapterSource = readFileSync('server/legacy-routes.ts', 'utf8');
  const mounted = new Set(
    [...adapterSource.matchAll(/\{ method: '(GET|POST|PATCH|DELETE)', path: '([^']+)'/g)].map(
      (match) => `${match[1]} ${match[2]}`
    )
  );

  const missing: string[] = [];
  for (const file of listRouteFiles(resolve('app/api'))) {
    const routeSource = readFileSync(file, 'utf8');
    const routePath = routePathFromFile(resolve(file));
    for (const match of routeSource.matchAll(/export async function (GET|POST|PATCH|DELETE)\b/g)) {
      const signature = `${match[1]} ${routePath}`;
      if (!mounted.has(signature)) missing.push(signature);
    }
  }

  assert.deepEqual(missing, [], `all exported legacy handlers must be mounted; missing: ${missing.join(', ')}`);
  console.log('legacy route coverage tests: ok');
}

main();
