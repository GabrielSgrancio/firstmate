import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_HOME = path.join(HERE, 'fixtures', 'router-v2');

export function makeRouterFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-v2-fixture-'));
  fs.cpSync(SOURCE_HOME, home, { recursive: true });
  process.env.FM_HOME = home;
  process.env.FM_DISABLE_LIVE_QUOTA = '1';
  return home;
}
