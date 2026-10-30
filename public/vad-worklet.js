// Voice activity detector running on the audio thread.
//
// Input 0: your microphone.
// Input 1: everything this page is playing out loud (other people + the warning tone).
//
// Works in 10 ms frames. Speech "starts" when a frame is loud enough AND most of the
// following confirmMs is also voiced (filters out clicks and taps). The reported onset is
// the first loud frame, so the server can compare who really started first.
// Speech "ends" after hangoverMs of quiet.
//
// Echo guard: when you use speakers, other people's voices come back into your mic. We know
// exactly what we just played, so two checks tell echo apart from you:
//  - Shape: echo rises and falls in step with the playback, a little later. We correlate the
//    syllable-by-syllable changes in mic loudness over the last 300 ms with the changes in
//    playback loudness at every delay up to 300 ms. Your own voice doesn't follow that pattern.
//  - Level: from sound that matches the shape, we learn how loud the leak is ("coupling"), and
//    only count the mic as you when it's clearly louder than the echo we'd expect.
// When nothing is playing (a gap, which is exactly when collisions happen) the guard does
// nothing at all.

const FAR_ACTIVE_DB = -60;   // playback quieter than this can't produce a meaningful echo
const ENV_FLOOR_DB = -70;    // silence is clamped to this so it doesn't dominate the correlation
const CORR_WINDOW = 30;      // frames (300 ms) compared
const CORR_ECHO = 0.75;      // correlation above this means "this is echo"
const MIN_LAG = 2;           // frames: real echo takes at least ~20 ms to go out the speaker and back in
const MAX_STEP_DB = 6;       // cap on one frame's change, so a single onset can't dominate

class VadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameLen = Math.round(sampleRate / 100);
    this.acc = 0;
    this.farAcc = 0;
    this.n = 0;
    this.noise = -60;           // tracked noise floor, dBFS
    this.p = {
      thresholdDb: -45, marginDb: 10, confirmMs: 100, hangoverMs: 600,
      echoGuard: true, echoMarginDb: 6, echoLagMs: 300,
    };
    this.maxLag = Math.ceil(this.p.echoLagMs / 10);
    this.envLen = CORR_WINDOW + this.maxLag + 1;
    this.micEnv = new Float32Array(this.envLen).fill(ENV_FLOOR_DB);
    this.farEnv = new Float32Array(this.envLen).fill(ENV_FLOOR_DB);
    this.envPos = 0;            // index of the newest frame
    this.echoCorr = 0;
    this.couplingDb = -15;      // learned: echo level relative to playback level
    this.state = 'idle';        // idle | confirming | speaking
    this.onset = 0;
    this.voicedInConfirm = 0;
    this.framesInConfirm = 0;
    this.echoRun = 0;
    this.lastEchoReport = -10;
    this.lastVoiced = 0;
    this.frameCount = 0;
    this.port.onmessage = e => Object.assign(this.p, e.data);
  }

  frame(db, farDb) {
    const t = currentTime;
    // Noise floor: drops quickly, rises slowly, so speech doesn't drag it up.
    this.noise = db < this.noise ? db : this.noise + 0.01;
    const loud = db > Math.max(this.p.thresholdDb, this.noise + this.p.marginDb);

    this.envPos = (this.envPos + 1) % this.envLen;
    this.micEnv[this.envPos] = Math.max(db, ENV_FLOOR_DB);
    this.farEnv[this.envPos] = Math.max(farDb, ENV_FLOOR_DB);
    // Loudest playback in the recent past: echo arrives after output + room delay.
    let farPeak = -120;
    for (let k = 0; k <= this.maxLag; k++) farPeak = Math.max(farPeak, this.farEnv[this.at(k)]);

    let echo = false;
    this.echoCorr = 0;
    if (this.p.echoGuard && farPeak > FAR_ACTIVE_DB) {
      const ratio = db - farPeak;
      if (db > this.noise + 3) {
        this.echoCorr = this.bestCorrelation();
        if (this.echoCorr > CORR_ECHO) {
          // Rises fast (so a loud speaker is learnt within a few frames), falls slowly.
          this.couplingDb += ratio > this.couplingDb ? 0.25 * (ratio - this.couplingDb) : 0.02 * (ratio - this.couplingDb);
          this.couplingDb = Math.max(-50, Math.min(15, this.couplingDb));
        }
      }
      echo = this.echoCorr > CORR_ECHO || db < farPeak + this.couplingDb + this.p.echoMarginDb;
    }
    const voiced = loud && !echo;
    if (voiced) this.lastVoiced = t;

    // Report when the guard just stopped something that would otherwise have counted as speech.
    if (loud && echo && this.state !== 'speaking') {
      if (++this.echoRun === Math.ceil(this.p.confirmMs / 10) && t - this.lastEchoReport > 1) {
        this.lastEchoReport = t;
        this.port.postMessage({ type: 'echo' });
      }
    } else if (!loud) {
      this.echoRun = 0;
    }

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

    if (++this.frameCount % 5 === 0) {
      this.port.postMessage({
        type: 'level', db, voiced, echo,
        echoDb: farPeak > FAR_ACTIVE_DB && this.p.echoGuard ? farPeak + this.couplingDb + this.p.echoMarginDb : null,
      });
    }
  }

  // Ring-buffer index of the frame `back` frames ago.
  at(back) { return (this.envPos - back + this.envLen) % this.envLen; }

  // Change in loudness between a frame and the one before it.
  delta(env, back) {
    const d = env[this.at(back)] - env[this.at(back + 1)];
    return Math.max(-MAX_STEP_DB, Math.min(MAX_STEP_DB, d));
  }

  // Highest correlation between recent changes in mic loudness and in playback loudness,
  // at any plausible delay. Comparing capped changes (not levels), and never at a delay too
  // short for real echo, stops a single step, like you starting to talk at the moment their
  // voice starts playing, from looking like echo.
  bestCorrelation() {
    const W = CORR_WINDOW;
    let mSum = 0, mSq = 0;
    for (let k = 0; k < W; k++) { const m = this.delta(this.micEnv, k); mSum += m; mSq += m * m; }
    const mVar = mSq - mSum * mSum / W;
    if (mVar < W) return 0;   // mic barely changing (under ~1 dB spread): no shape to compare
    let best = 0;
    for (let lag = MIN_LAG; lag <= this.maxLag; lag++) {
      let fSum = 0, fSq = 0, cross = 0;
      for (let k = 0; k < W; k++) {
        const f = this.delta(this.farEnv, k + lag);
        fSum += f; fSq += f * f; cross += f * this.delta(this.micEnv, k);
      }
      const fVar = fSq - fSum * fSum / W;
      if (fVar < W) continue;
      const r = (cross - mSum * fSum / W) / Math.sqrt(mVar * fVar);
      if (r > best) best = r;
    }
    return best;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    const far = inputs[1]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.acc += ch[i] * ch[i];
        if (far) this.farAcc += far[i] * far[i];
        if (++this.n === this.frameLen) {
          this.frame(10 * Math.log10(this.acc / this.n + 1e-12), 10 * Math.log10(this.farAcc / this.n + 1e-12));
          this.acc = 0;
          this.farAcc = 0;
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('vad', VadProcessor);
