import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dannyAudio', {
  readAudio: (): Promise<Float32Array | null> =>
    ipcRenderer.invoke('wasapi-read-audio'),
  stopCapture: (): Promise<void> => ipcRenderer.invoke('wasapi-stop'),
});
