import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BgProgress, SajaruApi } from '@shared/types'

/**
 * Puente seguro renderer <-> main. Las mini apps usan `window.api`,
 * nunca tocan Node ni `ipcRenderer` directamente (contextIsolation: true).
 */
const api: SajaruApi = {
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    run: (pluginId, input) => ipcRenderer.invoke('plugins:run', pluginId, input)
  },
  backgroundRemove: {
    setImage: (bytes, name) => ipcRenderer.invoke('bg:setImage', bytes, name),
    process: (config) => ipcRenderer.invoke('bg:process', config),
    loadResult: (bytes, format) => ipcRenderer.invoke('bg:loadResult', bytes, format),
    saveAll: (items) => ipcRenderer.invoke('bg:saveAll', items),
    modelsList: () => ipcRenderer.invoke('bg:modelsList'),
    modelsDownload: (id) => ipcRenderer.invoke('bg:modelsDownload', id),
    saveResult: (suggestedName) => ipcRenderer.invoke('bg:saveResult', suggestedName),
    copyResult: () => ipcRenderer.invoke('bg:copyResult'),
    updateResult: (bytes) => ipcRenderer.invoke('bg:updateResult', bytes),
    vectorizeResult: () => ipcRenderer.invoke('bg:vectorizeResult'),
    contourResult: (config) => ipcRenderer.invoke('bg:contourResult', config),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('bg:progress', listener)
      return () => ipcRenderer.removeListener('bg:progress', listener)
    }
  },
  vectorize: {
    setImage: (bytes, name) => ipcRenderer.invoke('vec:setImage', bytes, name),
    process: (config) => ipcRenderer.invoke('vec:process', config),
    areaFill: (rect) => ipcRenderer.invoke('vec:areaFill', rect),
    clearAreaFills: () => ipcRenderer.invoke('vec:clearAreaFills'),
    saveSvg: (suggestedName) => ipcRenderer.invoke('vec:saveSvg', suggestedName),
    savePng: (suggestedName) => ipcRenderer.invoke('vec:savePng', suggestedName),
    saveLayerSvg: (color, suggestedName) =>
      ipcRenderer.invoke('vec:saveLayerSvg', color, suggestedName),
    saveVector: (format, suggestedName) =>
      ipcRenderer.invoke('vec:saveVector', format, suggestedName),
    copyResult: () => ipcRenderer.invoke('vec:copyResult'),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('vec:progress', listener)
      return () => ipcRenderer.removeListener('vec:progress', listener)
    }
  },
  upscale: {
    setImage: (bytes, name) => ipcRenderer.invoke('ups:setImage', bytes, name),
    process: (config) => ipcRenderer.invoke('ups:process', config),
    saveResult: (suggestedName) => ipcRenderer.invoke('ups:saveResult', suggestedName),
    copyResult: () => ipcRenderer.invoke('ups:copyResult'),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('ups:progress', listener)
      return () => ipcRenderer.removeListener('ups:progress', listener)
    }
  },
  generate: {
    process: (config) => ipcRenderer.invoke('gen:process', config),
    saveResult: (suggestedName) => ipcRenderer.invoke('gen:saveResult', suggestedName),
    copyResult: () => ipcRenderer.invoke('gen:copyResult'),
    hasApiKey: () => ipcRenderer.invoke('gen:hasApiKey'),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('gen:progress', listener)
      return () => ipcRenderer.removeListener('gen:progress', listener)
    }
  },
  recraft: {
    balance: () => ipcRenderer.invoke('recraft:balance')
  },
  mockup3d: {
    renderVideo: (frames, config) => ipcRenderer.invoke('m3d:renderVideo', frames, config),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('m3d:progress', listener)
      return () => ipcRenderer.removeListener('m3d:progress', listener)
    }
  },
  printPrep: {
    setImage: (bytes, name) => ipcRenderer.invoke('pp:setImage', bytes, name),
    process: (config) => ipcRenderer.invoke('pp:process', config),
    saveResult: (suggestedName) => ipcRenderer.invoke('pp:saveResult', suggestedName),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('pp:progress', listener)
      return () => ipcRenderer.removeListener('pp:progress', listener)
    }
  },
  editor: {
    save: (bytes, suggestedName) => ipcRenderer.invoke('ed:save', bytes, suggestedName),
    copy: (bytes) => ipcRenderer.invoke('ed:copy', bytes)
  },
  samSelect: {
    encode: (bytes, name, model) => ipcRenderer.invoke('sam:encode', bytes, name, model),
    decode: (input) => ipcRenderer.invoke('sam:decode', input),
    everything: (bytes, name, model) => ipcRenderer.invoke('sam:everything', bytes, name, model),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('sam:progress', listener)
      return () => ipcRenderer.removeListener('sam:progress', listener)
    },
    onEverythingProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, ev: BgProgress): void => cb(ev)
      ipcRenderer.on('sam:everythingProgress', listener)
      return () => ipcRenderer.removeListener('sam:everythingProgress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
