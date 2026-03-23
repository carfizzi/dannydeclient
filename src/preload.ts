import {ipcRenderer} from 'electron';
import path from 'path';
import fs from 'fs';

let ncEnabled = false;

// RNNoise source files — read once at startup, reused per pipeline
let rnnoiseJsCode: string | null = null;
let rnnoiseWasmBinary: Uint8Array | null = null;

function loadRNNoiseFiles(): void {
  const distDir = path.join(
    __dirname,
    '..',
    'node_modules',
    '@jitsi',
    'rnnoise-wasm',
    'dist'
  );
  // Strip the ESM export — the worklet blob is loaded as a plain script
  let code = fs.readFileSync(path.join(distDir, 'rnnoise.js'), 'utf8');
  code = code.replace(/^export default createRNNWasmModule;$/m, '');
  rnnoiseJsCode = code;
  rnnoiseWasmBinary = new Uint8Array(
    fs.readFileSync(path.join(distDir, 'rnnoise.wasm'))
  );
  console.log('[Preload] RNNoise files loaded');
}

try {
  loadRNNoiseFiles();
} catch (err) {
  console.error('[Preload] Failed to load RNNoise files:', err);
}

// IPC: main process toggles noise cancellation
ipcRenderer.on('nc-toggle', (_event, enabled: boolean) => {
  ncEnabled = enabled;
  console.log('[Preload] Noise cancellation:', enabled ? 'on' : 'off');
});

// Monkey-patch getUserMedia to intercept microphone streams
const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
  navigator.mediaDevices
);

navigator.mediaDevices.getUserMedia = async function (
  constraints?: MediaStreamConstraints
): Promise<MediaStream> {
  const stream = await originalGetUserMedia(constraints);

  if (!constraints?.audio || !ncEnabled) {
    return stream;
  }

  if (!rnnoiseJsCode || !rnnoiseWasmBinary) {
    console.warn('[Preload] RNNoise not loaded, using raw stream');
    return stream;
  }

  try {
    return await buildRNNoisePipeline(stream, rnnoiseJsCode, rnnoiseWasmBinary);
  } catch (err) {
    console.error('[Preload] RNNoise pipeline failed, using raw stream:', err);
    return stream;
  }
};

// AudioWorklet processor — injected into a blob URL alongside the RNNoise factory.
// Plain JS: runs in AudioWorkletGlobalScope (no Node.js, no TypeScript).
// createRNNWasmModule is defined by the prepended rnnoise.js code.
const WORKLET_PROCESSOR_SRC = `
class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const FRAME_SIZE = 480;
    const BUF_CAP = FRAME_SIZE * 24; // 11520 samples

    this._frameSize = FRAME_SIZE;
    this._ready = false;

    this._inputBuf = new Float32Array(BUF_CAP);
    this._inputLen = 0;
    this._outputBuf = new Float32Array(BUF_CAP);
    this._outputStart = 0;
    this._outputEnd = 0;

    // Initialise WASM inside the worklet thread using the binary passed via
    // processorOptions (structured-cloned from the main thread).
    createRNNWasmModule({wasmBinary: options.processorOptions.wasmBinary})
      .then((mod) => {
        this._mod = mod;
        this._inPtr  = mod._malloc(FRAME_SIZE * 4);
        this._outPtr = mod._malloc(FRAME_SIZE * 4);
        this._state  = mod._rnnoise_create(0);
        this._ready  = true;
      });
  }

  process(inputs, outputs) {
    const input  = inputs[0]  && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!input || !output) return true;

    if (!this._ready) {
      // WASM not ready yet — output silence and keep the node alive
      output.fill(0);
      return true;
    }

    const FRAME_SIZE = this._frameSize;
    const mod = this._mod;

    // 1. Append incoming 128-sample quantum to input accumulator
    this._inputBuf.set(input, this._inputLen);
    this._inputLen += input.length;

    // 2. Process all complete 480-sample RNNoise frames
    let src = 0;
    while (src + FRAME_SIZE <= this._inputLen) {
      const inBase  = this._inPtr  >> 2;
      const outBase = this._outPtr >> 2;

      // Write to WASM heap — always re-read mod.HEAPF32 to handle heap growth
      for (let i = 0; i < FRAME_SIZE; i++) {
        mod.HEAPF32[inBase + i] = this._inputBuf[src + i] * 32768;
      }
      mod._rnnoise_process_frame(this._state, this._outPtr, this._inPtr);
      for (let i = 0; i < FRAME_SIZE; i++) {
        this._outputBuf[this._outputEnd + i] = mod.HEAPF32[outBase + i] / 32768;
      }
      this._outputEnd += FRAME_SIZE;
      src += FRAME_SIZE;
    }

    // 3. Compact input accumulator
    if (src > 0) {
      this._inputBuf.copyWithin(0, src, this._inputLen);
      this._inputLen -= src;
    }

    // 4. Compact output ring when the read pointer has drifted far enough
    const BUF_CAP = this._outputBuf.length;
    if (this._outputStart > BUF_CAP / 2) {
      this._outputBuf.copyWithin(0, this._outputStart, this._outputEnd);
      this._outputEnd  -= this._outputStart;
      this._outputStart = 0;
    }

    // 5. Drain exactly output.length samples so the output quantum is always full
    const available = this._outputEnd - this._outputStart;
    if (available >= output.length) {
      output.set(
        this._outputBuf.subarray(this._outputStart, this._outputStart + output.length)
      );
      this._outputStart += output.length;
    } else {
      // Only on the very first few quanta while the pipeline warms up
      output.set(
        this._outputBuf.subarray(this._outputStart, this._outputStart + available)
      );
      output.fill(0, available);
      this._outputStart += available;
    }

    return true; // keep processor alive
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
`;

async function buildRNNoisePipeline(
  stream: MediaStream,
  jsCode: string,
  wasmBinary: Uint8Array
): Promise<MediaStream> {
  const audioCtx = new AudioContext({sampleRate: 48000});

  // Build a single-file worklet blob: RNNoise factory + processor class.
  // createRNNWasmModule is defined at module scope by the prepended jsCode,
  // so the class constructor can call it directly.
  const blob = new Blob([jsCode, '\n', WORKLET_PROCESSOR_SRC], {
    type: 'application/javascript',
  });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await audioCtx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const destination = audioCtx.createMediaStreamDestination();

  // wasmBinary is structured-cloned into the worklet thread (~200 KB, one-time cost)
  const workletNode = new AudioWorkletNode(audioCtx, 'rnnoise-processor', {
    processorOptions: {wasmBinary},
  });

  source.connect(workletNode);
  workletNode.connect(destination);

  const outStream = new MediaStream();
  stream.getVideoTracks().forEach((t) => outStream.addTrack(t));
  destination.stream.getAudioTracks().forEach((t) => outStream.addTrack(t));

  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      void audioCtx.close();
    });
  });

  return outStream;
}
