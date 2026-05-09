const { contextBridge, ipcRenderer } = require('electron');

const FS_CHANNEL = 'zephyr-editor:fs';
const FS_EVENT_CHANNEL = 'zephyr-editor:fs-event';
const LOG_CHANNEL = 'zephyr-editor:log';
const SETTINGS_CHANNEL = 'zephyr-editor:settings';
const ASSISTANT_EVENT_CHANNEL = 'zephyr-editor:assistant-event';

function invokeFS(operation, args) {
  return ipcRenderer.invoke(FS_CHANNEL, { operation, args });
}

function invokeSettings(operation, args) {
  return ipcRenderer.invoke(SETTINGS_CHANNEL, { operation, args });
}

contextBridge.exposeInMainWorld('zephyrEditorDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  fs: {
    makeDirectory: (scope, path, recursive) => invokeFS('makeDirectory', { scope, path, recursive }),
    revealPath: (scope, path) => invokeFS('revealPath', { scope, path }),
    pickDirectory: (options) => invokeFS('pickDirectory', { options }),
    pickFile: (options) => invokeFS('pickFile', { options }),
    readDirectory: (scope, path, options) => invokeFS('readDirectory', { scope, path, options }),
    deleteDirectory: (scope, path, recursive) => invokeFS('deleteDirectory', { scope, path, recursive }),
    readFile: (scope, path, options) => invokeFS('readFile', { scope, path, options }),
    writeFile: (scope, path, data, options) => invokeFS('writeFile', { scope, path, data, options }),
    deleteFile: (scope, path) => invokeFS('deleteFile', { scope, path }),
    exists: (scope, path) => invokeFS('exists', { scope, path }),
    stat: (scope, path) => invokeFS('stat', { scope, path }),
    move: (scope, sourcePath, targetPath, options) =>
      invokeFS('move', { scope, sourcePath, targetPath, options }),
    deleteScope: (scope) => invokeFS('deleteScope', { scope }),
    watch: (scope, path) => invokeFS('watch', { scope, path }),
    unwatch: (watchId) => invokeFS('unwatch', { watchId }),
    onChange: (listener) => {
      if (typeof listener !== 'function') {
        return () => {};
      }
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on(FS_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(FS_EVENT_CHANNEL, handler);
      };
    }
  },
  settings: {
    getGlobalSettings: () => invokeSettings('getGlobalSettings', {}),
    saveGlobalSettings: (settings) => invokeSettings('saveGlobalSettings', { settings }),
    copyMcpServiceUrl: () => invokeSettings('copyMcpServiceUrl', {}),
    toggleDevTools: () => invokeSettings('toggleDevTools', {}),
    setLlmApiKey: (provider, apiKey) => invokeSettings('setLlmApiKey', { provider, apiKey }),
    clearLlmApiKey: (provider) => invokeSettings('clearLlmApiKey', { provider }),
    createAssistantSession: (title) => invokeSettings('createAssistantSession', { title }),
    listAssistantSessions: () => invokeSettings('listAssistantSessions', {}),
    getAssistantSessionMessages: (sessionId) => invokeSettings('getAssistantSessionMessages', { sessionId }),
    sendAssistantMessage: (sessionId, content, attachments) =>
      invokeSettings('sendAssistantMessage', { sessionId, content, attachments }),
    cancelAssistantRun: (sessionId) => invokeSettings('cancelAssistantRun', { sessionId }),
    approveAssistantToolCall: (sessionId, callId) =>
      invokeSettings('approveAssistantToolCall', { sessionId, callId }),
    rejectAssistantToolCall: (sessionId, callId) =>
      invokeSettings('rejectAssistantToolCall', { sessionId, callId }),
    onAssistantEvent: (listener) => {
      if (typeof listener !== 'function') {
        return () => {};
      }
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on(ASSISTANT_EVENT_CHANNEL, handler);
      return () => {
        ipcRenderer.removeListener(ASSISTANT_EVENT_CHANNEL, handler);
      };
    }
  }
});

window.addEventListener('error', (event) => {
  ipcRenderer.send(LOG_CHANNEL, {
    type: 'error',
    message: `${event.message || event.error}\n${event.error?.stack || ''}`
  });
});

window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.send(LOG_CHANNEL, {
    type: 'unhandledrejection',
    message: `${event.reason?.stack || event.reason || ''}`
  });
});
