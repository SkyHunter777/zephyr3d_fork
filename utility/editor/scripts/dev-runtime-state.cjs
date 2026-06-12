const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeEditorRoot(editorRoot) {
  return path.resolve(editorRoot);
}

function toStateKey(editorRoot) {
  const normalizedRoot = normalizeEditorRoot(editorRoot);
  return normalizedRoot.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function canUseDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getRuntimeBaseDir(editorRoot) {
  const explicitDir =
    typeof process.env.ZEPHYR_EDITOR_DEV_RUNTIME_DIR === 'string' ? process.env.ZEPHYR_EDITOR_DEV_RUNTIME_DIR.trim() : '';
  const candidates = [];
  if (explicitDir) {
    candidates.push(path.resolve(explicitDir));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Zephyr3DEditor', 'dev-runtime'));
  }
  candidates.push(path.join(normalizeEditorRoot(editorRoot), '.dev-runtime'));
  candidates.push(path.join(os.tmpdir(), 'Zephyr3DEditor', 'dev-runtime'));

  for (const candidate of candidates) {
    if (candidate && canUseDirectory(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find a writable directory for the Zephyr3D Editor dev runtime state.');
}

function getRuntimeStateDir(editorRoot) {
  return path.join(getRuntimeBaseDir(editorRoot), toStateKey(editorRoot));
}

function ensureRuntimeStateDir(editorRoot) {
  const stateDir = getRuntimeStateDir(editorRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function getRuntimeStateFilePath(editorRoot) {
  return path.join(getRuntimeStateDir(editorRoot), 'state.json');
}

function getRuntimeLogFilePath(editorRoot) {
  return path.join(getRuntimeStateDir(editorRoot), 'launcher.log');
}

function readRuntimeState(editorRoot) {
  try {
    return JSON.parse(fs.readFileSync(getRuntimeStateFilePath(editorRoot), 'utf8'));
  } catch {
    return null;
  }
}

function writeRuntimeState(editorRoot, state) {
  ensureRuntimeStateDir(editorRoot);
  const filePath = getRuntimeStateFilePath(editorRoot);
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return filePath;
}

function clearRuntimeState(editorRoot) {
  try {
    fs.rmSync(getRuntimeStateFilePath(editorRoot), { force: true });
  } catch {
    // Ignore stale state cleanup errors.
  }
}

function clearRuntimeStateIfOwned(editorRoot, runnerPid) {
  const state = readRuntimeState(editorRoot);
  if (state?.runnerPid === runnerPid) {
    clearRuntimeState(editorRoot);
  }
}

module.exports = {
  clearRuntimeState,
  clearRuntimeStateIfOwned,
  ensureRuntimeStateDir,
  getRuntimeLogFilePath,
  getRuntimeStateDir,
  getRuntimeStateFilePath,
  readRuntimeState,
  writeRuntimeState
};
