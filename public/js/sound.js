/* Sound effects and ambience, synthesized with Web Audio (no audio files to ship).
 * Browsers only allow audio after a user gesture, so call Sound.unlock() on the first click or key.
 */
(function () {
  const KEY = 'li.audio';
  let ctx = null;
  let master = null;
  let ambient = null;
  let ambientOn = false;
  let timers = [];
  let state = { volume: 0.6, muted: false };

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) state = { ...state, ...saved };
  } catch (_e) { /* private mode or blocked storage: keep defaults */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_e) { /* ignore */ }
  }

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = state.muted ? 0 : state.volume;
    master.connect(ctx.destination);
    return ctx;
  }

  function applyVolume() {
    if (master) master.gain.setTargetAtTime(state.muted ? 0 : state.volume, ctx.currentTime, 0.02);
  }

  function noiseBuffer(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function burst({ filter = 'bandpass', freq = 2000, q = 1, dur = 0.02, gain = 0.4, when = 0 }) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(dur + 0.02);
    const f = c.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.03);
  }

  function tone({ freq, type = 'sine', dur = 0.1, gain = 0.2, when = 0, slideTo = null }) {
    const c = ensure();
    if (!c) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  const Sound = {
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume();
    },

    get volume() { return state.volume; },
    get muted() { return state.muted; },

    setVolume(v) {
      state.volume = Math.max(0, Math.min(1, v));
      save();
      applyVolume();
    },

    toggleMute() {
      state.muted = !state.muted;
      save();
      applyVolume();
      return state.muted;
    },

    // Typewriter click for each new message.
    type() {
      burst({ freq: 3200 + Math.random() * 900, q: 6, dur: 0.012, gain: 0.35 });
    },

    // Clock tick in the last 10 seconds.
    tick() {
      tone({ freq: 1800, type: 'square', dur: 0.012, gain: 0.08 });
    },

    // Gavel slam on the verdict.
    gavel() {
      tone({ freq: 140, slideTo: 60, dur: 0.35, gain: 0.9 });
      burst({ filter: 'lowpass', freq: 900, q: 0.7, dur: 0.12, gain: 0.9 });
      tone({ freq: 90, slideTo: 40, dur: 0.6, gain: 0.5, when: 0.08 });
      burst({ filter: 'bandpass', freq: 2600, q: 2, dur: 0.05, gain: 0.5, when: 0.02 });
    },

    // Drumroll before the reveal: quick rolls that speed up over the duration.
    drumroll(seconds = 3) {
      const c = ensure();
      if (!c) return;
      let t = 0;
      let rate = 0.09;
      while (t < seconds) {
        burst({ filter: 'bandpass', freq: 1200, q: 0.8, dur: 0.03, gain: 0.22, when: t });
        t += rate;
        rate = Math.max(0.028, rate * 0.955);
      }
    },

    // Short buzz when someone is refused or a power card fires.
    buzz() {
      tone({ freq: 220, type: 'sawtooth', dur: 0.25, gain: 0.12 });
    },

    chime() {
      tone({ freq: 880, dur: 0.25, gain: 0.12 });
      tone({ freq: 1320, dur: 0.35, gain: 0.08, when: 0.08 });
    },

    // Noir ambience for the lobby: a low drone, rain hiss and sparse piano plucks.
    startAmbient() {
      const c = ensure();
      if (!c || ambientOn) return;
      ambientOn = true;
      ambient = c.createGain();
      ambient.gain.value = 0.0;
      ambient.gain.linearRampToValueAtTime(0.5, c.currentTime + 3);
      ambient.connect(master);

      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      lp.connect(ambient);
      [55, 55.6, 82.4].forEach((f, i) => {
        const o = c.createOscillator();
        o.type = i === 2 ? 'triangle' : 'sawtooth';
        o.frequency.value = f;
        const g = c.createGain();
        g.gain.value = i === 2 ? 0.05 : 0.035;
        o.connect(g).connect(lp);
        o.start();
      });

      const rain = c.createBufferSource();
      rain.buffer = noiseBuffer(2);
      rain.loop = true;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3800;
      const rg = c.createGain();
      rg.gain.value = 0.025;
      rain.connect(hp).connect(rg).connect(ambient);
      rain.start();

      // Sparse minor-key plucks: A minor pentatonic with a little tension.
      const notes = [220, 261.6, 293.7, 329.6, 392, 440, 523.3];
      const pluck = () => {
        if (!ambientOn) return;
        const f = notes[Math.floor(Math.random() * notes.length)];
        tone({ freq: f, type: 'triangle', dur: 2.2, gain: 0.05 });
        timers.push(setTimeout(pluck, 1400 + Math.random() * 2600));
      };
      timers.push(setTimeout(pluck, 900));
      ambient.nodes = [rain];
    },

    stopAmbient() {
      if (!ambientOn) return;
      ambientOn = false;
      timers.forEach(clearTimeout);
      timers = [];
      if (ambient && ctx) {
        ambient.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
        const dead = ambient;
        setTimeout(() => dead.disconnect(), 1400);
      }
      ambient = null;
    },
  };

  window.Sound = Sound;
})();
