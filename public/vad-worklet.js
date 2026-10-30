// Voice activity detector running on the audio thread.
// Works in 10 ms frames. Speech "starts" when a frame is loud enough AND most of the
// following confirmMs is also voiced (filters out clicks and taps). The reported onset is
// the first loud frame, so the server can compare who really started first.
// Speech "ends" after hangoverMs of quiet.

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameLen = Math.round(sampleRate / 100);
    this.acc = 0;
    this.n = 0;
    this.noise = -60;           // tracked noise floor, dBFS
    this.p = { thresholdDb: -45, marginDb: 10, confirmMs: 100, hangoverMs: 600 };
    this.state = 'idle';        // idle | confirming | speaking
    this.onset = 0;
    this.voicedInConfirm = 0;
    this.framesInConfirm = 0;
    this.lastVoiced = 0;
    this.levelEvery = 5;
    this.frameCount = 0;
    this.port.onmessage = e => Object.assign(this.p, e.data);
  }

  frame(db) {
    const t = currentTime;
    // Noise floor: drops quickly, rises slowly, so speech doesn't drag it up.
    this.noise = db < this.noise ? db : this.noise + 0.01;
    const voiced = db > Math.max(this.p.thresholdDb, this.noise + this.p.marginDb);
    if (voiced) this.lastVoiced = t;

    if (this.state === 'idle') {
      if (voiced) {
        this.state = 'confirming';
        this.onset = t - this.frameLen / sampleRate;
        this.voicedInConfirm = 1;
        this.framesInConfirm = 1;
      }
    } else if (this.state === 'confirming') {
      this.framesInConfirm++;
      if (voiced) this.voicedInConfirm++;
      if (this.framesInConfirm * 10 >= this.p.confirmMs) {
        if (this.voicedInConfirm / this.framesInConfirm >= 0.6) {
          this.state = 'speaking';
          this.port.postMessage({ type: 'start', onset: this.onset, now: t });
        } else {
          this.state = 'idle';
        }
      }
    } else if (t - this.lastVoiced > this.p.hangoverMs / 1000) {
      this.state = 'idle';
      this.port.postMessage({ type: 'end', lastVoiced: this.lastVoiced, now: t });
    }

    if (++this.frameCount % this.levelEvery === 0) {
      this.port.postMessage({ type: 'level', db, noise: this.noise, voiced });
    }
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.acc += ch[i] * ch[i];
        if (++this.n === this.frameLen) {
          this.frame(10 * Math.log10(this.acc / this.n + 1e-12));
          this.acc = 0;
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('vad', VadProcessor);
