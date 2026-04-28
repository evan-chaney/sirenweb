/**
 * Siren AudioWorklet Processor
 * Generates a pulse-train waveform simulating a mechanical rotary siren disk.
 * The pulse frequency is: f(t) = N * RPM(t) / 60
 * where RPM(t) = baseRPM + wailDepth * wailMod(t)
 */

class SirenProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'holes',       defaultValue: 6,    minValue: 1,    maxValue: 24,   automationRate: 'k-rate' },
      { name: 'baseRPM',     defaultValue: 1800, minValue: 0,    maxValue: 6000, automationRate: 'k-rate' },
      { name: 'wailDepth',   defaultValue: 800,  minValue: 0,    maxValue: 3000, automationRate: 'k-rate' },
      { name: 'wailRate',    defaultValue: 0.5,  minValue: 0.01, maxValue: 3,    automationRate: 'k-rate' },
      { name: 'wailShape',   defaultValue: 0,    minValue: 0,    maxValue: 2,    automationRate: 'k-rate' },
      { name: 'dutyCycle',   defaultValue: 0.5,  minValue: 0.05, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'holeShape',   defaultValue: 0,    minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
      { name: 'slotSkew',    defaultValue: 0.5,  minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
      { name: 'volume',      defaultValue: 0.7,  minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
      { name: 'ring2enabled',defaultValue: 0,    minValue: 0,    maxValue: 1,    automationRate: 'k-rate' },
      { name: 'ring2holes',  defaultValue: 12,   minValue: 1,    maxValue: 24,   automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._phase1 = 0;
    this._phase2 = 0;
    this._wailPhase = 0;
    // Single-pole high-pass filter state (removes DC offset)
    this._hpX = 0;
    this._hpY = 0;
    this._hpAlpha = 0.9997; // ~10 Hz cutoff at 44100 Hz
  }

  /**
   * Compute pulse amplitude for a given phase position.
   * shape=0: round hole (rectangular pulse)
   * shape=1: slot (trapezoidal pulse — softer edges, less high-frequency content)
   */
  pulseValue(phase, duty, shape, skew) {
    // phase is 0..1, duty is the fraction of the cycle the pulse is open
    if (phase >= duty) return 0;

    if (shape < 0.5) {
      // Round hole: rectangular pulse
      return 1;
    } else {
      // Slot: trapezoidal pulse
      // skew controls what fraction of the pulse width is sloped (0=rectangular, 1=triangular)
      const q = phase / duty; // normalized position within pulse [0..1]
      const halfSlope = skew / 2;
      if (halfSlope < 0.005) return 1; // effectively rectangular
      if (q < halfSlope) return q / halfSlope;              // rising edge
      if (q > (1 - halfSlope)) return (1 - q) / halfSlope; // falling edge
      return 1;                                              // flat top
    }
  }

  /**
   * Wail modulator: maps phase [0..1] to [-1..1] according to shape.
   */
  wailMod(phase, shape) {
    switch (shape) {
      case 1: // triangle
        return 1 - 4 * Math.abs(phase - 0.5);
      case 2: // sawtooth (slow rise, snap back — like a police yelp)
        return 2 * phase - 1;
      default: // sine
        return Math.sin(2 * Math.PI * phase);
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0];
    if (!channel) return true;

    const SR = sampleRate; // global in AudioWorkletGlobalScope

    // Read k-rate parameters once per block
    const holes       = Math.max(1, Math.round(parameters.holes[0]));
    const baseRPM     = parameters.baseRPM[0];
    const wailDepth   = parameters.wailDepth[0];
    const wailRate    = parameters.wailRate[0];
    const wailShape   = Math.round(parameters.wailShape[0]);
    const duty        = parameters.dutyCycle[0];
    const holeShape   = parameters.holeShape[0];
    const slotSkew    = parameters.slotSkew[0];
    const volume      = parameters.volume[0];
    const ring2on     = parameters.ring2enabled[0] > 0.5;
    const ring2holes  = Math.max(1, Math.round(parameters.ring2holes[0]));

    const hp = this._hpAlpha;

    for (let i = 0; i < channel.length; i++) {
      // Wail modulation — compute instantaneous RPM
      const mod = this.wailMod(this._wailPhase, wailShape);
      const rpm = Math.max(0, baseRPM + wailDepth * mod);
      const rotPerSec = rpm / 60;

      // Advance phases
      const f1 = holes * rotPerSec;
      this._phase1 += f1 / SR;
      if (this._phase1 >= 1) this._phase1 -= Math.floor(this._phase1);

      this._wailPhase += wailRate / SR;
      if (this._wailPhase >= 1) this._wailPhase -= Math.floor(this._wailPhase);

      // Ring 1 sample
      let raw = this.pulseValue(this._phase1, duty, holeShape, slotSkew);

      // Ring 2 (optional second hole ring on same disk)
      if (ring2on) {
        const f2 = ring2holes * rotPerSec;
        this._phase2 += f2 / SR;
        if (this._phase2 >= 1) this._phase2 -= Math.floor(this._phase2);
        raw = (raw + this.pulseValue(this._phase2, duty, holeShape, slotSkew)) * 0.5;
      }

      // High-pass filter to remove DC offset
      const hpOut = hp * (this._hpY + raw - this._hpX);
      this._hpX = raw;
      this._hpY = hpOut;

      channel[i] = hpOut * volume;
    }

    return true;
  }
}

registerProcessor('siren-processor', SirenProcessor);
