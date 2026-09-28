// Resamples mic input (any rate) to 24 kHz mono and emits 480-sample (20 ms) frames.
const OUT_RATE = 24000, FRAME = 480;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.buf = [];
    this.pos = 0;
    this.out = new Float32Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this.buf.push(ch[i]);

    while (this.pos + 1 < this.buf.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      this.out[this.n++] = this.buf[i] * (1 - f) + this.buf[i + 1] * f;
      if (this.n === FRAME) {
        this.port.postMessage(this.out, [this.out.buffer]);
        this.out = new Float32Array(FRAME);
        this.n = 0;
      }
      this.pos += this.ratio;
    }
    const k = Math.floor(this.pos);
    this.buf = this.buf.slice(k);
    this.pos -= k;
    return true;
  }
}

registerProcessor('capture', Capture);
