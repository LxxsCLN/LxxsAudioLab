// AudioWorkletProcessor — runs on the audio render thread.
// Computes RMS, peak, and dBFS from PCM input buffers.
// Sends metrics to the main thread via postMessage.

class AnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._alive = true;

    // Windowed RMS: accumulate squared samples over multiple buffers.
    // At 48kHz with 128-sample buffers, we get ~375 buffers/sec.
    // A ~50ms window = ~24 buffers. We'll use a ring buffer of squared sums.
    this._windowSize = 24;
    this._rmsWindow = new Float64Array(this._windowSize);
    this._windowIndex = 0;
    this._samplesInWindow = new Uint32Array(this._windowSize);

    // Throttle postMessage to ~15 times/sec (every ~25 buffers at 48kHz/128).
    this._messageInterval = 25;
    this._bufferCount = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === "stop") {
        this._alive = false;
      }
    };
  }

  process(inputs, outputs) {
    if (!this._alive) return false;

    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    // --- Passthrough: copy input to output unchanged ---
    for (let ch = 0; ch < input.length; ch++) {
      if (input[ch] && output[ch]) {
        output[ch].set(input[ch]);
      }
    }

    // --- Compute metrics from channel 0 (mono analysis) ---
    const samples = input[0];
    if (!samples || samples.length === 0) return true;

    let sumSquares = 0;
    let peak = 0;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      sumSquares += s * s;
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
    }

    // Store in ring buffer for windowed RMS.
    this._rmsWindow[this._windowIndex] = sumSquares;
    this._samplesInWindow[this._windowIndex] = samples.length;
    this._windowIndex = (this._windowIndex + 1) % this._windowSize;

    // Throttle messages.
    this._bufferCount++;
    if (this._bufferCount < this._messageInterval) return true;
    this._bufferCount = 0;

    // Compute windowed RMS across all stored buffers.
    let totalSquares = 0;
    let totalSamples = 0;
    for (let i = 0; i < this._windowSize; i++) {
      totalSquares += this._rmsWindow[i];
      totalSamples += this._samplesInWindow[i];
    }

    const rms = totalSamples > 0 ? Math.sqrt(totalSquares / totalSamples) : 0;

    // Convert to dBFS. Full scale = 1.0, so dBFS = 20 * log10(value).
    // Clamp to -100 dBFS for silence.
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -100;

    this.port.postMessage({
      rms,
      rmsDb: Math.round(rmsDb * 10) / 10,
      peak,
      peakDb: Math.round(peakDb * 10) / 10,
      channelCount: input.length,
      sampleRate: sampleRate,
    });

    return true;
  }
}

registerProcessor("analyzer-processor", AnalyzerProcessor);
