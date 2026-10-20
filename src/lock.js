// Single-instance PID lock. Two daemons would both claim inbox files and race
// session files, so refuse to start when another live process holds the lock.

import fs from 'node:fs';
import path from 'node:path';

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return {
        release() {
          try {
            const owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
            if (owner === process.pid) fs.rmSync(file, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let owner = null;
      try {
        owner = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      } catch {
        // unreadable/stale
      }
      if (alive(owner)) {
        throw new Error(`another wabox-pi is running (pid ${owner}, lock ${file})`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`could not acquire lock ${file}`);
}
