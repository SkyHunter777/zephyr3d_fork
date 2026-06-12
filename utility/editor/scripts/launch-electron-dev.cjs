const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  clearRuntimeState,
  ensureRuntimeStateDir,
  getRuntimeLogFilePath,
  readRuntimeState,
  writeRuntimeState
} = require('./dev-runtime-state.cjs');

const editorRoot = path.resolve(__dirname, '..');
const devRunnerScript = path.join(__dirname, 'electron-dev.cjs');

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveElectronBinary() {
  try {
    return require('electron');
  } catch {
    throw new Error('Electron dependency is not installed. Run npm install or rush update first.');
  }
}

function appendLauncherLog(logPath, message) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function launchElectronInstance(existingState) {
  const electronBinary = resolveElectronBinary();
  const env = {
    ...process.env
  };
  if (existingState?.devUrl) {
    env.ZEPHYR_EDITOR_ELECTRON_URL = existingState.devUrl;
  }
  const child = spawn(electronBinary, ['.'], {
    cwd: editorRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  });
  child.unref();
}

function startDetachedDevRunner() {
  ensureRuntimeStateDir(editorRoot);
  const logPath = getRuntimeLogFilePath(editorRoot);
  const logFd = fs.openSync(logPath, 'a');
  appendLauncherLog(logPath, 'Starting detached Electron dev runner');
  const child = spawn(process.execPath, [devRunnerScript], {
    cwd: editorRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env
    }
  });
  child.unref();
  fs.closeSync(logFd);
  writeRuntimeState(editorRoot, {
    version: 1,
    status: 'launching',
    editorRoot,
    runnerPid: child.pid,
    serverPid: null,
    electronPid: null,
    devUrl: '',
    logPath,
    updatedAt: new Date().toISOString()
  });
}

function main() {
  const existingState = readRuntimeState(editorRoot);
  if (existingState?.runnerPid && isPidRunning(existingState.runnerPid)) {
    if ((existingState.electronPid && isPidRunning(existingState.electronPid)) || existingState.devUrl) {
      launchElectronInstance(existingState);
    }
    return;
  }
  clearRuntimeState(editorRoot);
  startDetachedDevRunner();
}

try {
  main();
} catch (error) {
  const stateDir = ensureRuntimeStateDir(editorRoot);
  const logPath = getRuntimeLogFilePath(editorRoot);
  appendLauncherLog(logPath, `Launcher failed: ${error?.stack || error}`);
  process.stderr.write(`Failed to launch Zephyr3D Editor dev runtime. See ${path.join(stateDir, path.basename(logPath))}\n`);
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}
