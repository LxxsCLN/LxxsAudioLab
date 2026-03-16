// AudioWorkletProcessor — runs on the audio render thread.
// Phase 2: passthrough (audio in = audio out, no modification).
// Phase 3 will add RMS, peak, and dBFS computation here.

class AnalyzerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._alive = true;

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

    // Passthrough — copy input samples to output unchanged.
    if (input && input.length > 0) {
      for (let channel = 0; channel < input.length; channel++) {
        const inputChannel = input[channel];
        const outputChannel = output[channel];
        if (inputChannel && outputChannel) {
          outputChannel.set(inputChannel);
        }
      }
    }

    // Return true to keep the processor alive.
    return true;
  }
}

registerProcessor("analyzer-processor", AnalyzerProcessor);
