const crypto = require('crypto');
const path = require('path');

function unlinkIfExists(fs, filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup only. The next write uses a fresh random temp name.
  }
}

function fsyncExistingFile(fs, filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function writeDurableTempFile(fs, filePath, content) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'w');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function atomicWriteFile(filePath, content, options = {}) {
  const fs = options.fs || require('fs');
  const randomSuffix = options.randomSuffix || (() => crypto.randomBytes(8).toString('hex'));
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const suffix = randomSuffix();
  const tempPath = path.join(dir, `${baseName}.${suffix}.tmp`);
  const backupPath = `${filePath}.bak`;
  const backupTempPath = path.join(dir, `${baseName}.bak.${suffix}.tmp`);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    writeDurableTempFile(fs, tempPath, content);

    const destinationExists = fs.existsSync(filePath);
    if (destinationExists && fs.statSync(filePath).size > 0) {
      fs.copyFileSync(filePath, backupTempPath);
      fsyncExistingFile(fs, backupTempPath);
      fs.renameSync(backupTempPath, backupPath);
    }

    fs.renameSync(tempPath, filePath);
  } catch (err) {
    unlinkIfExists(fs, tempPath);
    unlinkIfExists(fs, backupTempPath);
    throw err;
  }
}

module.exports = { atomicWriteFile };
