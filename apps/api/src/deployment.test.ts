import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests over the Docker build, not over TypeScript.
 *
 * Every bug below was live and invisible: the stack built cleanly, every
 * container reported healthy, and the dashboard still could not log in. Nothing
 * in the type system or the unit suite touches a Dockerfile, so these are the
 * only place that catches it before a deploy does.
 *
 * The rule they encode: what the image runs must be what the repo means, and
 * the documented operator commands must be runnable inside it.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const apiDockerfile = read('docker/Dockerfile.api');
const webDockerfile = read('docker/Dockerfile.web');
const apiPkg = JSON.parse(read('apps/api/package.json'));

describe('API image', () => {
  it('starts the hardened server, not the original scaffold', () => {
    // src/index.ts mounts neither /api/auth nor /api/gb. Booting it gives a
    // dashboard that cannot sign in and a LaunchPad where every call 404s.
    expect(apiDockerfile).toMatch(/CMD \["node", "apps\/api\/dist\/indexHardened\.js"\]/);
    expect(apiDockerfile).not.toMatch(/dist\/index\.js/);
    expect(apiPkg.scripts.start).toBe('node dist/indexHardened.js');
  });

  it('mounts the auth and GB routes the dashboard depends on', () => {
    const server = read('apps/api/src/indexHardened.ts');
    for (const route of ['/api/auth', '/api/gb', '/api/catalog', '/api/strategies']) {
      expect(server).toContain(`app.use('${route}'`);
    }
  });

  it('ships the sources the operator scripts run from', () => {
    // db:migrate, create-admin, fleet:check and tradovate:preflight are all
    // `tsx src/...`. Without src in the image, every documented setup step in
    // docs/DEPLOY.md fails inside the container.
    expect(apiDockerfile).toMatch(/COPY --from=builder \/app\/apps\/api\/src \.\/apps\/api\/src/);
  });

  it('healthchecks address 127.0.0.1, never localhost', () => {
    // Node listens on 0.0.0.0 (IPv4 only). Inside a container `localhost`
    // resolves to ::1 first, so the probe is refused while the server is
    // serving perfectly — the container reports unhealthy forever. Caught on
    // the first real deploy, where `docker compose ps` said unhealthy and
    // `curl /health` from the host returned 200.
    const compose = read('docker/docker-compose.yml');
    for (const [name, text] of [['compose', compose], ['Dockerfile.api', apiDockerfile]] as const) {
      const probes = [...text.matchAll(/wget[^\n]*?(https?:\/\/[^\s"']+)/g)].map((m) => m[1]);
      for (const url of probes) {
        expect(url, `${name} healthcheck must not probe localhost`).not.toMatch(/\/\/localhost[:/]/);
      }
    }
    expect(compose).toContain('http://127.0.0.1:3001/health');
  });

  it('keeps tsx a runtime dependency', () => {
    // The production stage installs --omit=dev. A dev-only tsx means every
    // operator command is "tsx: not found" on the server.
    expect(apiDockerfile).toContain('--omit=dev');
    expect(apiPkg.dependencies).toHaveProperty('tsx');
    expect(apiPkg.devDependencies ?? {}).not.toHaveProperty('tsx');
  });
});

describe('migrations', () => {
  it('every schema file the runner names exists on disk', () => {
    // migrate.ts warns and SKIPS a missing .sql file, then exits 0. A typo or a
    // file that never got copied into the image produces a half-migrated
    // database and a success message.
    const migrate = read('apps/api/src/db/migrate.ts');
    const named = [...migrate.matchAll(/__dirname, '([^']+\.sql)'/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(10);
    for (const file of named) {
      expect(
        fs.existsSync(path.join(repoRoot, 'apps/api/src/db', file)),
        `migrate.ts runs ${file} but it does not exist`,
      ).toBe(true);
    }
  });

  it('every schema file on disk is actually run', () => {
    const migrate = read('apps/api/src/db/migrate.ts');
    const onDisk = fs
      .readdirSync(path.join(repoRoot, 'apps/api/src/db'))
      .filter((f) => f.endsWith('.sql'));
    for (const file of onDisk) {
      expect(migrate, `${file} exists but migrate.ts never runs it`).toContain(`'${file}'`);
    }
  });
});

describe('documented commands', () => {
  const rootPkg = JSON.parse(read('package.json'));
  const docs = ['docs/DEPLOY.md', 'docs/LOGIN.md'].map(read).join('\n');

  it('every `npm run X` the docs run in a container is a root script', () => {
    // The container's working directory is the repo root, so `npm run X` there
    // resolves against the ROOT package.json, not apps/api's. A script that
    // only exists in the workspace gives "Missing script" at the one moment
    // someone is following the setup guide.
    const used = [
      ...docs.matchAll(/docker compose (?:exec|run)(?: --rm| -\w+)* api npm run ([\w:-]+)/g),
    ].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const script of new Set(used)) {
      expect(rootPkg.scripts, `docs run "npm run ${script}" in the container`).toHaveProperty(
        script,
      );
    }
  });

  it('bootstrap commands use `run`, not `exec`', () => {
    // The API exits on an un-migrated database, so on a fresh stack its
    // container is restarting and `exec` has nothing to attach to. db:migrate
    // and create-admin are exactly the commands someone reaches for at that
    // moment, so both must be documented as `run --rm`.
    for (const script of ['db:migrate', 'create-admin']) {
      expect(
        docs,
        `${script} must be documented as \`docker compose run --rm api\` — ` +
          'exec cannot work before the first migration',
      ).toContain(`docker compose run --rm api npm run ${script}`);
      expect(docs).not.toContain(`docker compose exec api npm run ${script}`);
    }
  });

  it('the login screen names the same command as the docs', () => {
    // The one place a stranded operator actually reads. It drifted from the
    // docs once already, within an hour of being written.
    const authGate = read('apps/web/src/components/AuthGate.tsx');
    expect(authGate).toContain('docker compose run --rm api npm run create-admin');
  });

  it('root scripts forward arguments to the workspace', () => {
    // `npm run create-admin --workspace=X` swallows trailing flags as npm's
    // own. The trailing `--` is what makes `-- --email you@example.com` reach
    // the script instead of being parsed away.
    for (const [name, cmd] of Object.entries(rootPkg.scripts as Record<string, string>)) {
      if (!/create-admin|create-user|fleet:check|tradovate:preflight|eval:sim|feasibility/.test(name)) continue;
      expect(cmd, `${name} must end with " --" to forward arguments`).toMatch(/ --$/);
    }
  });
});

describe('web image', () => {
  it('takes the browser-facing API URL as a build arg', () => {
    // NEXT_PUBLIC_* is inlined at build time. Setting it in compose
    // `environment:` does nothing to an already-built bundle.
    expect(webDockerfile).toMatch(/ARG NEXT_PUBLIC_API_URL/);
    expect(webDockerfile).toMatch(/ENV NEXT_PUBLIC_API_URL=\$NEXT_PUBLIC_API_URL/);
  });

  it('has a public directory to copy', () => {
    // git does not track empty directories, so an empty apps/web/public is
    // absent after a clone and the COPY fails the build outright.
    const pub = path.join(repoRoot, 'apps/web/public');
    expect(fs.existsSync(pub)).toBe(true);
    expect(fs.readdirSync(pub).length).toBeGreaterThan(0);
  });
});
