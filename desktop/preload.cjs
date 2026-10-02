const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('llamaDesktop', {
  getState: () => ipcRenderer.invoke('llama:get-state'),
  saveConfig: payload => ipcRenderer.invoke('llama:save-config', payload),
  startServer: payload => ipcRenderer.invoke('llama:start-server', payload),
  stopServer: () => ipcRenderer.invoke('llama:stop-server'),
  testHealth: payload => ipcRenderer.invoke('llama:test-health', payload),
  getSystemInfo: () => ipcRenderer.invoke('llama:get-system-info'),
  inspectPort: payload => ipcRenderer.invoke('llama:inspect-port', payload),
  clientSmokeTest: payload => ipcRenderer.invoke('llama:client-smoke-test', payload),
  chatCompletion: payload => ipcRenderer.invoke('llama:chat-completion', payload),
  streamChat: payload => ipcRenderer.invoke('llama:chat-stream', payload),
  cancelChat: requestId => ipcRenderer.invoke('llama:cancel-chat', { requestId }),
  getModelInfo: payload => ipcRenderer.invoke('llama:get-model-info', payload),
  pickFile: options => ipcRenderer.invoke('llama:pick-file', options?.properties ? options : { filters: options }),
  pickAttachments: payload => ipcRenderer.invoke('llama:pick-attachments', payload),
  importAttachments: payload => ipcRenderer.invoke('llama:import-attachments', payload),
  revealPath: filePath => ipcRenderer.invoke('llama:reveal-path', { filePath }),
  openUrl: url => ipcRenderer.invoke('llama:open-url', { url }),
  onEvent: callback => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('llama:event', handler)
    return () => ipcRenderer.removeListener('llama:event', handler)
  },


  // P0-1: Preset APIs
  presetList: () => ipcRenderer.invoke('llama:preset-list'),
  presetRead: name => ipcRenderer.invoke('llama:preset-read', name),
  presetWrite: ({ name, config }) => ipcRenderer.invoke('llama:preset-write', { name, config }),
  presetDelete: name => ipcRenderer.invoke('llama:preset-delete', name),
  // P0-2: Engine APIs
  engineList: () => ipcRenderer.invoke('llama:engine-list'),
  engineDetect: serverPath => ipcRenderer.invoke('llama:engine-detect', serverPath),
  // P1-2: VRAM check
  vramCheck: () => ipcRenderer.invoke('llama:vram-check'),
  // 本地模型清单（顶栏模型折叠菜单）
  listModels: () => ipcRenderer.invoke('llama:list-models'),
  // 按本机硬件生成稳定预设
  stablePreset: payload => ipcRenderer.invoke('llama:stable-preset', payload),
  // P2-2: Preset metadata
  presetMetadata: ({ name, config }) => ipcRenderer.invoke('llama:preset-metadata', { name, config }),
  presetSummaries: () => ipcRenderer.invoke('llama:preset-summaries'),

  // Branding
  getVersion: () => ipcRenderer.invoke('app:version'),
  getAppName: () => ipcRenderer.invoke('app:name'),
  setTitleBarTheme: payload => ipcRenderer.invoke('app:set-titlebar-theme', payload),
})