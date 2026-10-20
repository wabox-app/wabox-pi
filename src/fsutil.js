// Filesystem helpers.
//
// wabox's inbox/outbox and our state dir are not guaranteed to be on the same
// filesystem (data dir vs state dir can be separate mounts), so a plain rename
// is not enough: fall back to copy + unlink on EXDEV.

import fs from 'node:fs/promises';

export async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }
}
