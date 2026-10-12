// Original composition "Night Shift at the Merge Gate" — MIT.
// Eight-bar phrases, four harmonic sections. No samples or runtime hosts.
export type Theme = 'title' | 'battle' | 'victory' | 'draw';
const roots = [40, 40, 36, 38, 40, 43, 38, 35];
const melodies = [
  [76, 0, 79, 76, 74, 0, 71, 74, 76, 0, 83, 79, 78, 76, 74, 71],
  [79, 0, 83, 86, 83, 79, 78, 76, 74, 0, 78, 81, 79, 78, 74, 71],
  [71, 74, 76, 0, 79, 78, 76, 74, 72, 0, 76, 79, 78, 74, 72, 69],
  [83, 0, 79, 78, 76, 74, 71, 0, 74, 78, 81, 78, 76, 74, 71, 0],
];
export class ArcadeAudio {
  context: AudioContext | null = null;
  music: GainNode | null = null;
  effects: GainNode | null = null;
  master: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  theme: Theme = 'title';
  requestedTheme: Theme = 'title';
  endingStart = 0;
  intensity = 0;
  muted = false;
  musicVolume = 0.32;
  effectsVolume = 0.55;
  step = 0;
  next = 0;
  timer: number | null = null;
  noise: AudioBuffer | null = null;
  voices = 0;
  async start() {
    if (!this.context) {
      const ctx = (this.context = new AudioContext());
      this.master = ctx.createGain();
      this.music = ctx.createGain();
      this.effects = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.music.connect(this.master);
      this.effects.connect(this.master);
      this.master.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      let seed = 0x4d4b;
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
      }
      this.next = ctx.currentTime + 0.06;
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
    await this.context.resume();
    this.volumes();
  }
  volumes() {
    if (!this.context) return;
    const at = this.context.currentTime;
    this.master!.gain.setTargetAtTime(this.muted ? 0 : 0.55, at, 0.04);
    this.music!.gain.setTargetAtTime(this.musicVolume, at, 0.06);
    this.effects!.gain.setTargetAtTime(this.effectsVolume, at, 0.02);
  }
  setTheme(theme: Theme) {
    this.requestedTheme = theme;
  }
  tone(
    note: number,
    time: number,
    length: number,
    volume: number,
    type: OscillatorType = 'square',
    bus = this.music,
  ) {
    const ctx = this.context;
    if (!ctx || !bus || !note) return;
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(440 * Math.pow(2, (note - 69) / 12), time);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + length);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(time);
    osc.stop(time + length + 0.01);
    this.voices++;
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      this.voices--;
    };
  }
  drum(time: number, kind: 'kick' | 'snare' | 'hat', vol = 0.2) {
    const ctx = this.context;
    if (!ctx || !this.noise) return;
    const gain = ctx.createGain();
    gain.connect(this.music!);
    gain.gain.setValueAtTime(vol, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + (kind === 'hat' ? 0.045 : 0.15));
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(140, time);
      o.frequency.exponentialRampToValueAtTime(35, time + 0.12);
      o.connect(gain);
      o.start(time);
      o.stop(time + 0.17);
      o.onended = () => {
        o.disconnect();
        gain.disconnect();
      };
    } else {
      const s = ctx.createBufferSource(),
        filter = ctx.createBiquadFilter();
      s.buffer = this.noise;
      filter.type = 'highpass';
      filter.frequency.value = kind === 'hat' ? 7000 : 1500;
      s.connect(filter);
      filter.connect(gain);
      s.start(time);
      s.stop(time + 0.16);
      s.onended = () => {
        s.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    }
  }
  schedule() {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    if (this.next < ctx.currentTime - 0.3) this.next = ctx.currentTime + 0.03;
    let guard = 0;
    while (this.next < ctx.currentTime + 0.12 && guard++ < 12) {
      const s = this.step % 16,
        bar = Math.floor(this.step / 16),
        section = Math.floor(bar / 8) % 4;
      if (s === 0 && this.theme !== this.requestedTheme) {
        this.theme = this.requestedTheme;
        this.endingStart = this.step;
      }
      const tempo =
        this.theme === 'title' ? 104 : this.theme === 'battle' ? 132 + this.intensity * 16 : 108;
      const beat = 60 / tempo / 4;
      let root = roots[bar % 8];
      if (this.theme === 'victory' || this.theme === 'draw') {
        const end = this.step - this.endingStart;
        const cadence =
          this.theme === 'victory'
            ? [76, 79, 83, 88, 83, 86, 88, 88]
            : [76, 74, 71, 69, 67, 66, 64, 64];
        if (end < 32 && s % 4 === 0) {
          this.tone(cadence[Math.floor(end / 4)], this.next, beat * 5, 0.11, 'triangle');
          this.tone(this.theme === 'victory' ? 40 : 35, this.next, beat * 5, 0.2, 'triangle');
          if (end === 0) this.drum(this.next, 'kick', 0.2);
        }
        this.next += beat;
        this.step++;
        continue;
      }
      if (s % 2 === 0)
        this.tone(root + (s === 6 || s === 14 ? 12 : 0), this.next, beat * 1.6, 0.24, 'triangle');
      if (this.theme === 'title') {
        if (s % 2 === 0)
          this.tone(melodies[0][s] - (bar % 2 ? 12 : 0), this.next, beat * 2.5, 0.075, 'triangle');
      } else {
        this.tone(
          melodies[section][s] + (bar % 8 === 2 ? -4 : 0),
          this.next,
          beat * 0.85,
          0.095,
          section % 2 ? 'triangle' : 'square',
        );
        if (section >= 2 && s % 4 === 0)
          this.tone(root + 24, this.next, beat * 3, 0.035, 'sawtooth');
      }
      if (s === 0 || s === 8 || (this.intensity > 0.5 && s === 10))
        this.drum(this.next, 'kick', 0.3);
      if (s === 4 || s === 12) this.drum(this.next, 'snare', 0.12);
      if (s % 2 === 0) this.drum(this.next, 'hat', 0.032);
      this.next += beat;
      this.step++;
    }
  }
  noiseEffect(time: number, length: number, frequency: number, volume: number) {
    const ctx = this.context;
    if (!ctx || !this.noise) return;
    const source = ctx.createBufferSource(),
      filter = ctx.createBiquadFilter(),
      gain = ctx.createGain();
    source.buffer = this.noise;
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(frequency, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(90, frequency / 4), time + length);
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + length);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.effects!);
    source.start(time);
    source.stop(time + length + 0.01);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }
  thump(time: number, strength = 1) {
    const ctx = this.context;
    if (!ctx) return;
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, time);
    osc.frequency.exponentialRampToValueAtTime(32, time + 0.2);
    gain.gain.setValueAtTime(0.42 * strength, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
    osc.connect(gain);
    gain.connect(this.effects!);
    osc.start(time);
    osc.stop(time + 0.28);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }
  effect(kind: string) {
    const ctx = this.context;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01,
      bus = this.effects;
    if (kind === 'swing') {
      this.noiseEffect(t, 0.12, 2600, 0.2);
      return;
    }
    if (kind === 'impact' || kind === 'landing') {
      this.thump(t, kind === 'landing' ? 1.4 : 1);
      this.noiseEffect(t, 0.18, kind === 'landing' ? 400 : 1600, 0.35);
      return;
    }
    if (kind === 'soft-impact') {
      this.tone(48, t, 0.13, 0.1, 'triangle', bus);
      return;
    }
    if (kind.startsWith('charge-')) {
      const claude = kind === 'charge-claude',
        notes = claude ? [60, 67, 72, 76, 79, 84] : [28, 35, 40, 47, 52, 59];
      notes.forEach((n, i) =>
        this.tone(n, t + i * 0.11, 0.21, 0.12, claude ? 'triangle' : 'sawtooth', bus),
      );
      this.music!.gain.setTargetAtTime(this.musicVolume * 0.45, t, 0.04);
      this.music!.gain.setTargetAtTime(this.musicVolume, t + 1.5, 0.22);
      return;
    }
    if (kind.startsWith('finisher-')) {
      const claude = kind === 'finisher-claude',
        notes = claude ? [84, 91, 96, 88, 79, 72] : [40, 52, 64, 71, 76, 88];
      notes.forEach((n, i) =>
        this.tone(n, t + i * 0.055, 0.3, 0.21, claude ? 'triangle' : 'square', bus),
      );
      this.thump(t, 1.65);
      this.noiseEffect(t, 0.45, claude ? 3400 : 850, 0.45);
      this.music!.gain.setTargetAtTime(this.musicVolume * 0.25, t, 0.02);
      this.music!.gain.setTargetAtTime(this.musicVolume, t + 0.8, 0.2);
      return;
    }
    const notes: Record<string, number[]> = {
      attack: [48, 36],
      counter: [63, 51],
      block: [91, 79],
      parry: [83, 90, 95],
      recoil: [57, 52, 45],
      combo: [72, 76, 79],
      special: [52, 64, 71, 76, 83, 88],
      'special-discovered': [76, 83, 88],
      fatigue: [38, 35],
      correction: [64, 60],
      finish: [64, 71, 76, 83],
      'ending-victory': [64, 71, 76, 83],
      'ending-draw': [76, 74, 71, 64],
    };
    const pitches = notes[kind];
    if (!pitches) return;
    pitches.forEach((n, i) =>
      this.tone(
        n,
        t + i * 0.06,
        0.16,
        kind === 'special' ? 0.3 : 0.18,
        kind === 'block' || kind === 'ending-draw' ? 'triangle' : 'square',
        bus,
      ),
    );
    if (['attack', 'counter', 'special', 'combo'].includes(kind)) this.thump(t);
    if (kind === 'block' || kind === 'parry') this.noiseEffect(t, 0.1, 4200, 0.16);
    if (kind === 'special') {
      this.music!.gain.setTargetAtTime(this.musicVolume * 0.4, t, 0.02);
      this.music!.gain.setTargetAtTime(this.musicVolume, t + 0.65, 0.15);
    }
  }
  diagnostics() {
    const data = new Float32Array(256);
    this.analyser?.getFloatTimeDomainData(data);
    return {
      state: this.context?.state ?? 'not-started',
      voices: this.voices,
      scheduledSteps: this.step,
      rms: Math.sqrt(data.reduce((s, n) => s + n * n, 0) / data.length),
      theme: this.theme,
      muted: this.muted,
    };
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    void this.context?.close();
  }
}
