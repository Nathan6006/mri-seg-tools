/**
 * The bridge between the page and the shell.
 *
 * The page feature-detects `window.desktopBridge` exactly the way it already
 * feature-detects `showDirectoryPicker`: present means the desktop powers are
 * available, absent means it is running in a plain browser and nothing here
 * exists. Keep this surface small -- every function is a capability the
 * sandboxed page gains, and the main process validates everything anyway.
 *
 * Bytes cross the bridge as Uint8Array (structured clone). The page's
 * pipeline wants File-like objects whose arrayBuffer() resolves to a plain
 * ArrayBuffer, so the scan reader converts here rather than making the web
 * code care.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const toArrayBuffer = (u8) =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

contextBridge.exposeInMainWorld('desktopBridge', {
  // -- scan ingest ----------------------------------------------------------
  // Returns [{token, name, files: [{rel, size}]}], one entry per folder the
  // user picked. Files are then read lazily, one at a time, as the pipeline
  // asks for them.
  pickScanFolders: () => ipcRenderer.invoke('scan:pick'),
  readScanFile: async (token, rel, start, end) =>
    toArrayBuffer(await ipcRenderer.invoke('scan:read', token, rel, start, end)),

  // -- the folder shared with ITK-SNAP --------------------------------------
  folderStatus: () => ipcRenderer.invoke('folder:status'),
  pickExportFolder: () => ipcRenderer.invoke('folder:pick'),
  forgetExportFolder: () => ipcRenderer.invoke('folder:forget'),
  writeCase: (caseName, files) => ipcRenderer.invoke('folder:writeCase', caseName, files),
  writeExportFile: (name, text) => ipcRenderer.invoke('folder:writeFile', name, text),
  readCaseMasks: (wanted) => ipcRenderer.invoke('folder:readMasks', wanted),
  revealExportFolder: () => ipcRenderer.invoke('folder:reveal'),

  // -- ITK-SNAP --------------------------------------------------------------
  itksnapAvailable: () => ipcRenderer.invoke('itksnap:available'),
  itksnapOpen: (caseName) => ipcRenderer.invoke('itksnap:open', caseName),
});
