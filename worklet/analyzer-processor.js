// AudioWorkletProcessor — runs on the audio render thread.
// Computes RMS, peak, dBFS, and applies loudness normalization.

class AnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._alive = true;

    // --- RMS windowing ---
    this._windowSize = 24;
    this._rmsWindow = new Float64Array(this._windowSize);
    this._windowIndex = 0;
    this._samplesInWindow = new Uint32Array(this._windowSize);

    // --- Normalization state ---
    this._normalizeEnabled = false;
    this._targetDb = -14;       // Target loudness in dBFS.
    this._maxGain = 4.0;        // Max gain multiplier (prevents boosting silence to noise).
    this._currentGain = 1.0;    // Smoothed gain value applied to output.
    // Attack = how fast gain decreases (loud signal detected).
    // Release = how fast gain increases (signal gets quieter).
    // Smaller = slower/smoother. Values are per-sample smoothing factors.
    this._attackCoeff = 0.005;
    this._releaseCoeff = 0.0005;

    // --- Smoothed dBFS for classification ---
    this._smoothedDb = -100;
    this._dbSmoothingCoeff = 0.05; // Slow smoothing to prevent jitter.

    // --- Throttle metrics messages ---
    this._messageInterval = 25;
    this._bufferCount = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === "stop") {
        this._alive = false;
      }
      if (e.data.type === "set-normalize") {
        this._normalizeEnabled = e.data.enabled;
        if (!this._normalizeEnabled) {
          this._currentGain = 1.0;
        }
      }
      if (e.data.type === "set-target-db") {
        const val = e.data.value;
        if (typeof val === "number" && val >= -60 && val <= 0) {
          this._targetDb = val;
        }
      }
    };
  }

  process(inputs, outputs) {
    if (!this._alive) return false;

    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    const samples = input[0];
    if (!samples || samples.length === 0) return true;

    // --- Compute metrics from channel 0 ---
    let sumSquares = 0;
    let peak = 0;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      sumSquares += s * s;
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
    }

    // Store in RMS ring buffer.
    this._rmsWindow[this._windowIndex] = sumSquares;
    this._samplesInWindow[this._windowIndex] = samples.length;
    this._windowIndex = (this._windowIndex + 1) % this._windowSize;

    // Compute windowed RMS.
    let totalSquares = 0;
    let totalSamples = 0;
    for (let i = 0; i < this._windowSize; i++) {
      totalSquares += this._rmsWindow[i];
      totalSamples += this._samplesInWindow[i];
    }
    const rms = totalSamples > 0 ? Math.sqrt(totalSquares / totalSamples) : 0;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;

    // --- Normalization: compute target gain ---
    let gainReduction = 0;

    if (this._normalizeEnabled && rms > 0.0001) {
      // Convert target dBFS to linear amplitude.
      const targetLinear = Math.pow(10, this._targetDb / 20);
      // Desired gain = target / current RMS.
      let desiredGain = targetLinear / rms;

      // Cap the gain to prevent boosting silence/noise.
      if (desiredGain > this._maxGain) desiredGain = this._maxGain;
      if (desiredGain < 0.01) desiredGain = 0.01;

      // Smooth gain using attack/release envelope.
      // If we need to reduce gain (signal is loud), use attack (fast).
      // If we need to increase gain (signal is quiet), use release (slow).
      const coeff = desiredGain < this._currentGain
        ? this._attackCoeff
        : this._releaseCoeff;

      this._currentGain += (desiredGain - this._currentGain) * coeff;

      gainReduction = 20 * Math.log10(this._currentGain);
    } else if (!this._normalizeEnabled) {
      // Smoothly return to unity gain when disabled.
      this._currentGain += (1.0 - this._currentGain) * 0.001;
      if (Math.abs(this._currentGain - 1.0) < 0.0001) this._currentGain = 1.0;
    }

    // --- Apply gain and copy to output ---
    const gain = this._currentGain;
    for (let ch = 0; ch < input.length; ch++) {
      const inp = input[ch];
      const out = output[ch];
      if (!inp || !out) continue;

      if (gain === 1.0) {
        out.set(inp);
      } else {
        for (let i = 0; i < inp.length; i++) {
          // Apply gain with soft clipping to prevent harsh distortion.
          let s = inp[i] * gain;
          // Clamp to [-1, 1] to prevent digital clipping.
          if (s > 1.0) s = 1.0;
          else if (s < -1.0) s = -1.0;
          out[i] = s;
        }
      }
    }

    // --- Throttle metrics messages ---
    this._bufferCount++;
    if (this._bufferCount < this._messageInterval) return true;
    this._bufferCount = 0;

    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -100;

    // Smooth the dBFS for classification display so it doesn't jitter.
    this._smoothedDb += (rmsDb - this._smoothedDb) * this._dbSmoothingCoeff;
    const smoothedDb = Math.round(this._smoothedDb * 10) / 10;

    this.port.postMessage({
      rms,
      rmsDb: Math.round(rmsDb * 10) / 10,
      smoothedDb,
      peak,
      peakDb: Math.round(peakDb * 10) / 10,
      channelCount: input.length,
      sampleRate: sampleRate,
      normalizeEnabled: this._normalizeEnabled,
      currentGain: Math.round(this._currentGain * 1000) / 1000,
      gainReductionDb: Math.round(gainReduction * 10) / 10,
    });

    return true;
  }
}

registerProcessor("analyzer-processor", AnalyzerProcessor);
