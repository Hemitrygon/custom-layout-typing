// 音（WebAudio でその場で合成する。音のファイルは持たない）。種類は旧版（v5）と同じ。
let ctx = null;
let enabled = true;

export function setSoundEnabled(on) { enabled = Boolean(on); }

function tone(type, steps, gain0, dur) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  for (const [f, at, ramp] of steps) {
    if (ramp) osc.frequency.exponentialRampToValueAtTime(f, now + at);
    else osc.frequency.setValueAtTime(f, now + at);
  }
  gain.gain.setValueAtTime(gain0, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);
}

/** @param {'key'|'error'|'count'|'wordDone'|'finish'|'shBeat'|'shClear'|'shBonus'|'shStage'|'shShield'|'shBreak'} type */
export function playSound(type) {
  if (!enabled) return;
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    switch (type) {
      case 'key': tone('triangle', [[520, 0], [180, 0.035, true]], 0.08, 0.035); break;
      case 'error': tone('sawtooth', [[160, 0], [135, 0.05]], 0.1, 0.12); break;
      case 'count': tone('sine', [[660, 0]], 0.07, 0.08); break;
      case 'wordDone': tone('sine', [[587.33, 0], [880, 0.045]], 0.07, 0.11); break;
      case 'finish': tone('sine', [[523.25, 0], [659.25, 0.09], [783.99, 0.18], [1046.5, 0.27]], 0.07, 0.55); break;
      case 'shBeat': tone('sine', [[70, 0], [40, 0.12, true]], 0.22, 0.16); break;
      case 'shClear': tone('triangle', [[660, 0], [990, 0.07]], 0.07, 0.2); break;
      case 'shBonus': tone('sine', [[880, 0], [1760, 0.1, true]], 0.05, 0.14); break;
      case 'shStage': tone('square', [[392, 0], [587, 0.09]], 0.045, 0.3); break;
      case 'shShield': tone('square', [[523, 0], [784, 0.09]], 0.045, 0.3); break;
      case 'shBreak': {
        // 文が砕ける音：だんだん小さくなる雑音
        const now = ctx.currentTime;
        const len = Math.floor(ctx.sampleRate * 0.6);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2400, now);
        filter.frequency.exponentialRampToValueAtTime(300, now + 0.6);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25, now);
        src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
        src.start(now);
        break;
      }
      default: break;
    }
  } catch { /* 音が出せなくても練習は続ける */ }
}
