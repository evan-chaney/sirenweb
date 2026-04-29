/**
 * Siren Lab — app.js
 *
 * Four synthesis modes share a common effects chain:
 *
 *   [sourceGain]
 *     ├─ [satDryGain] ──────────────────────────► [postSat]
 *     └─ [satDriveGain]─[waveShaper]─[satWetGain]► [postSat]
 *   [noiseSource]─[noiseBPF]─[noiseRPMGain]─[noiseEnableGain]─► [postSat]
 *   [postSat]──────────────────────────────────────────────────► [postHorn]
 *   [postSat]─[hornBPF×3]─[hornBoostGain]─────────────────────► [postHorn]
 *   [postHorn]─[analyserNode]─► destination + streamDest
 *
 * Mode-specific sources connect to [sourceGain]:
 *   mechanical : workletNode
 *   q2         : workletNode → q2PhaserGain
 *   electronic : electronicOsc → elecDrive → elecWS → elecBPF1+elecBPF2
 *                electronicHumOsc → elecHumGain
 *   twotone    : twoToneOsc → twoToneGapGain
 */

'use strict';

// ── Synthesis mode ────────────────────────────────────────────────────────────
let synthMode = 'mechanical'; // 'mechanical' | 'q2' | 'electronic' | 'twotone'

// ── Audio context & shared nodes ─────────────────────────────────────────────
let audioCtx       = null;
let analyserNode   = null;
let streamDest     = null;
let moduleLoaded   = false;
let isPlaying      = false;
let isRecording    = false;
let startTime      = 0;

// Shared effects chain nodes (rebuilt on each startPlayback)
let sourceGain      = null;
let satDryGain      = null;
let satDriveGain    = null;
let waveShaper      = null;
let satWetGain      = null;
let postSat         = null;
let hornBPFs        = [];
let hornBoostGain   = null;
let postHorn        = null;
let noiseSource     = null;
let noiseBPF        = null;
let noiseRPMGain    = null;
let noiseEnableGain = null;

// Effect toggle state (persists across play/stop)
const fx = { noise: false, horn: false, sat: false };

// ── Mechanical mode nodes ─────────────────────────────────────────────────────
let workletNode = null;

// ── Q2 mode nodes & state ─────────────────────────────────────────────────────
let q2PhaserGain   = null;
let q2Mode         = 'wail'; // 'wail' | 'yelp' | 'phaser' | 'priority'
let q2PriorityTimer = null;
let q2PrioritySub  = 'wail'; // 'wail' | 'coast' | 'yelp' | 'coast2'

const Q2_DESCS = {
  wail:     'Slow sine sweep · 0.4 Hz · Classic air-raid wail',
  yelp:     'Fast sawtooth · 2.5 Hz · Short sharp risings',
  phaser:   'Wail + rotor AM modulation · 1.2 Hz · The iconic "wah" layer',
  priority: 'Alternates Wail and Yelp every cycle with coast pause',
};

// ── Electronic mode nodes ─────────────────────────────────────────────────────
let electronicOsc    = null;
let electronicHumOsc = null;
let elecBPF1         = null;
let elecBPF2         = null;
let elecHumGain      = null;

// ── Two-tone mode nodes & state ───────────────────────────────────────────────
let twoToneOsc      = null;
let twoToneGapGain  = null;
let twoToneCurrent  = 'low';   // 'low' | 'gap_lo' | 'high' | 'gap_hi'
let twoToneTimeout  = null;
let twoToneCurrentHz = 500;    // for math display
let ttTransition    = 'hard';  // 'hard' | 'soft'

// ── UI state ──────────────────────────────────────────────────────────────────
let currentWailShape = 0; // 0=sine 1=tri 2=saw
let currentHoleShape = 0; // 0=round 1=slot

// ── Animation / recording ─────────────────────────────────────────────────────
let animFrame    = null;
let scopeBuffer  = null;
let frameCount   = 0;
let mediaRecorder = null;
let recChunks    = [];
let recTimer     = null;
let recCountdown = 0;

// ── Note names ────────────────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function freqToNote(freq) {
  if (!freq || freq <= 0) return '--';
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  if (midi < 0 || midi > 127) return '--';
  const name = NOTE_NAMES[midi % 12].replace('#', '\u266f');
  return name + (Math.floor(midi / 12) - 1);
}

function centsBetween(f1, f2) {
  if (!f1 || !f2 || f1 <= 0 || f2 <= 0) return 0;
  return Math.round(1200 * Math.log2(f2 / f1));
}

// ── Param helpers ─────────────────────────────────────────────────────────────
function getVal(id) {
  const el = document.getElementById(id);
  return el ? parseFloat(el.value) : 0;
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

// ── Worklet param push ────────────────────────────────────────────────────────
function updateAllParams() {
  if (!workletNode) return;
  const p = workletNode.parameters;
  p.get('holes').value        = getVal('holes');
  p.get('baseRPM').value      = getVal('baseRPM');
  p.get('wailDepth').value    = getVal('wailDepth');
  p.get('wailRate').value     = getVal('wailRate') / 100;
  p.get('dutyCycle').value    = getVal('dutyCycle') / 100;
  p.get('holeShape').value    = currentHoleShape;
  p.get('slotSkew').value     = getVal('slotSkew') / 100;
  p.get('volume').value       = getVal('volume') / 100;
  p.get('ring2enabled').value = document.getElementById('ring2enabled').checked ? 1 : 0;
  p.get('ring2holes').value   = getVal('ring2holes');
  p.get('wailShape').value    = currentWailShape;
}

// ── Waveshaper curve ──────────────────────────────────────────────────────────
function makeTanhCurve(drive, samples = 512) {
  const curve = new Float32Array(samples);
  const norm  = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

function rampGain(node, target, t = 0.025) {
  if (!audioCtx || !node) return;
  node.gain.linearRampToValueAtTime(target, audioCtx.currentTime + t);
}

// ── Effect toggles ────────────────────────────────────────────────────────────
function setEffect(name, enabled) {
  fx[name] = enabled;
  if (name === 'sat') {
    rampGain(satDryGain, enabled ? 0 : 1);
    rampGain(satWetGain, enabled ? 1 : 0);
    updateSatCurve();
    document.getElementById('satDriveRow').classList.toggle('dim', !enabled);
  }
  if (name === 'horn') {
    rampGain(hornBoostGain, enabled ? 0.4 : 0);
    document.getElementById('hornTuningRow').classList.toggle('dim', !enabled);
  }
  if (name === 'noise') {
    rampGain(noiseEnableGain, enabled ? 1 : 0);
    document.getElementById('noiseAmountRow').classList.toggle('dim', !enabled);
  }
}

function updateSatCurve() {
  if (waveShaper) waveShaper.curve = makeTanhCurve(getVal('satDrive'));
}

// ── Build shared effects chain ────────────────────────────────────────────────
function buildSharedChain() {
  sourceGain = audioCtx.createGain();
  sourceGain.gain.value = 1;

  // Saturation stage
  satDryGain   = audioCtx.createGain(); satDryGain.gain.value  = fx.sat ? 0 : 1;
  satDriveGain = audioCtx.createGain(); satDriveGain.gain.value = 1;
  waveShaper   = audioCtx.createWaveShaper();
  waveShaper.curve      = makeTanhCurve(getVal('satDrive'));
  waveShaper.oversample = '4x';
  satWetGain   = audioCtx.createGain(); satWetGain.gain.value  = fx.sat ? 1 : 0;
  postSat      = audioCtx.createGain(); postSat.gain.value      = 1;

  sourceGain.connect(satDryGain);
  sourceGain.connect(satDriveGain);
  satDriveGain.connect(waveShaper);
  waveShaper.connect(satWetGain);
  satDryGain.connect(postSat);
  satWetGain.connect(postSat);

  // Noise stage
  const bufLen   = Math.floor(audioCtx.sampleRate * 2);
  const noiseBuf = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const nd       = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1;
  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = noiseBuf; noiseSource.loop = true;
  noiseBPF = audioCtx.createBiquadFilter();
  noiseBPF.type = 'bandpass'; noiseBPF.frequency.value = 600; noiseBPF.Q.value = 1.2;
  noiseRPMGain    = audioCtx.createGain(); noiseRPMGain.gain.value    = 0;
  noiseEnableGain = audioCtx.createGain(); noiseEnableGain.gain.value = fx.noise ? 1 : 0;
  noiseSource.connect(noiseBPF);
  noiseBPF.connect(noiseRPMGain);
  noiseRPMGain.connect(noiseEnableGain);
  noiseEnableGain.connect(postSat);
  noiseSource.start();

  // Horn stage (resonant peak boost layer)
  postHorn      = audioCtx.createGain(); postHorn.gain.value      = 1;
  hornBoostGain = audioCtx.createGain(); hornBoostGain.gain.value = fx.horn ? 0.4 : 0;
  const hornFreqs = [700, 2100, 4400];
  const hornQs    = [3.5, 4.0,  3.0];
  hornBPFs = hornFreqs.map((f, i) => {
    const bpf = audioCtx.createBiquadFilter();
    bpf.type = 'bandpass'; bpf.frequency.value = f; bpf.Q.value = hornQs[i];
    postSat.connect(bpf); bpf.connect(hornBoostGain);
    return bpf;
  });
  postSat.connect(postHorn);
  hornBoostGain.connect(postHorn);
  postHorn.connect(analyserNode);

  // Sync sub-control dim state
  document.getElementById('satDriveRow').classList.toggle('dim',    !fx.sat);
  document.getElementById('hornTuningRow').classList.toggle('dim',  !fx.horn);
  document.getElementById('noiseAmountRow').classList.toggle('dim', !fx.noise);
}

// ── Mode-specific source chains ───────────────────────────────────────────────

function buildMechanicalChain() {
  workletNode = new AudioWorkletNode(audioCtx, 'siren-processor');
  workletNode.connect(sourceGain);
  updateAllParams();
}

function buildQ2Chain() {
  workletNode  = new AudioWorkletNode(audioCtx, 'siren-processor');
  q2PhaserGain = audioCtx.createGain();
  q2PhaserGain.gain.value = 1;
  workletNode.connect(q2PhaserGain);
  q2PhaserGain.connect(sourceGain);
  // Fixed Q2 disk settings
  const p = workletNode.parameters;
  p.get('holes').value      = 6;
  p.get('holeShape').value  = 0;
  p.get('dutyCycle').value  = 0.5;
  p.get('ring2enabled').value = 0;
  p.get('volume').value     = getVal('volume') / 100;
  applyQ2Pattern(q2Mode);
  if (q2Mode === 'priority') startQ2Priority();
}

function buildElectronicChain() {
  electronicOsc = audioCtx.createOscillator();
  electronicOsc.type = 'sine';
  electronicOsc.frequency.value = Math.max(20, getCurrentFreq());

  // Drive into distortion before horn BPFs — simulates amp clipping
  const elecDrive = audioCtx.createGain();
  elecDrive.gain.value = 3;
  const elecWS = audioCtx.createWaveShaper();
  elecWS.curve      = makeTanhCurve(4.5);
  elecWS.oversample = '4x';

  // Sharp horn speaker BPFs
  elecBPF1 = audioCtx.createBiquadFilter();
  elecBPF1.type = 'bandpass'; elecBPF1.frequency.value = getVal('elecPeak1'); elecBPF1.Q.value = 10;
  elecBPF2 = audioCtx.createBiquadFilter();
  elecBPF2.type = 'bandpass'; elecBPF2.frequency.value = getVal('elecPeak2'); elecBPF2.Q.value = 8;

  // 60 Hz power supply hum
  electronicHumOsc = audioCtx.createOscillator();
  electronicHumOsc.type = 'sine';
  electronicHumOsc.frequency.value = 60;
  elecHumGain = audioCtx.createGain();
  elecHumGain.gain.value = getVal('elecHum') / 100 * 0.04;

  electronicOsc.connect(elecDrive);
  elecDrive.connect(elecWS);
  elecWS.connect(elecBPF1);
  elecWS.connect(elecBPF2);
  elecBPF1.connect(sourceGain);
  elecBPF2.connect(sourceGain);
  electronicHumOsc.connect(elecHumGain);
  elecHumGain.connect(sourceGain);

  electronicOsc.start();
  electronicHumOsc.start();
}

function buildTwoToneChain() {
  twoToneOsc = audioCtx.createOscillator();
  twoToneOsc.type = 'sine';
  twoToneOsc.frequency.value = getVal('ttLowHz');
  twoToneGapGain = audioCtx.createGain();
  twoToneGapGain.gain.value = 1;
  twoToneOsc.connect(twoToneGapGain);
  twoToneGapGain.connect(sourceGain);
  twoToneOsc.start();
  twoToneCurrent = 'low';
  twoToneCurrentHz = getVal('ttLowHz');
  startTwoToneSequencer();
}

// ── Two-tone sequencer ────────────────────────────────────────────────────────
function startTwoToneSequencer() {
  clearTimeout(twoToneTimeout);
  twoToneCurrent = 'low';
  setTTFreq(getVal('ttLowHz'));
  twoToneCurrentHz = getVal('ttLowHz');
  scheduleTT();
}

function scheduleTT() {
  if (!isPlaying || synthMode !== 'twotone') return;

  if (twoToneCurrent === 'low') {
    twoToneTimeout = setTimeout(() => {
      const gap = getVal('ttGap');
      if (gap > 0) { twoToneCurrent = 'gap_lo'; setTTGain(0); }
      else         { twoToneCurrent = 'high';   setTTFreq(getVal('ttHighHz')); twoToneCurrentHz = getVal('ttHighHz'); }
      scheduleTT();
    }, getVal('ttLowDur'));

  } else if (twoToneCurrent === 'gap_lo') {
    twoToneTimeout = setTimeout(() => {
      twoToneCurrent = 'high';
      setTTFreq(getVal('ttHighHz'));
      twoToneCurrentHz = getVal('ttHighHz');
      setTTGain(1);
      scheduleTT();
    }, getVal('ttGap'));

  } else if (twoToneCurrent === 'high') {
    twoToneTimeout = setTimeout(() => {
      const gap = getVal('ttGap');
      if (gap > 0) { twoToneCurrent = 'gap_hi'; setTTGain(0); }
      else         { twoToneCurrent = 'low';    setTTFreq(getVal('ttLowHz')); twoToneCurrentHz = getVal('ttLowHz'); }
      scheduleTT();
    }, getVal('ttHighDur'));

  } else if (twoToneCurrent === 'gap_hi') {
    twoToneTimeout = setTimeout(() => {
      twoToneCurrent = 'low';
      setTTFreq(getVal('ttLowHz'));
      twoToneCurrentHz = getVal('ttLowHz');
      setTTGain(1);
      scheduleTT();
    }, getVal('ttGap'));
  }
}

function setTTFreq(hz) {
  if (!twoToneOsc || !audioCtx) return;
  if (ttTransition === 'soft') {
    twoToneOsc.frequency.linearRampToValueAtTime(hz, audioCtx.currentTime + 0.02);
  } else {
    twoToneOsc.frequency.setValueAtTime(hz, audioCtx.currentTime);
  }
}

function setTTGain(val) {
  if (!twoToneGapGain || !audioCtx) return;
  twoToneGapGain.gain.linearRampToValueAtTime(val, audioCtx.currentTime + 0.008);
}

function setTTTransition(t) {
  ttTransition = t;
  document.getElementById('ttHard').classList.toggle('active', t === 'hard');
  document.getElementById('ttSoft').classList.toggle('active', t === 'soft');
}

// ── Q2 patterns ───────────────────────────────────────────────────────────────
function applyQ2Pattern(mode) {
  if (!workletNode) return;
  const p = workletNode.parameters;
  if (mode === 'wail' || mode === 'phaser') {
    p.get('baseRPM').value  = 1800;
    p.get('wailDepth').value = 900;
    p.get('wailRate').value  = 0.4;
    p.get('wailShape').value = 0; // sine
  } else if (mode === 'yelp') {
    p.get('baseRPM').value  = 2400;
    p.get('wailDepth').value = 400;
    p.get('wailRate').value  = 2.5;
    p.get('wailShape').value = 2; // sawtooth
  }
  // 'coast' state during priority transitions
}

function setQ2Mode(mode) {
  q2Mode = mode;
  ['wail','yelp','phaser','priority'].forEach(m =>
    document.getElementById('q2' + m.charAt(0).toUpperCase() + m.slice(1)).classList.toggle('active', m === mode)
  );
  document.getElementById('q2Desc').textContent = Q2_DESCS[mode] || '';
  document.getElementById('q2PhaserRow').style.opacity      = mode === 'phaser'   ? '1' : '0.3';
  document.getElementById('q2PhaserRow').style.pointerEvents = mode === 'phaser'  ? '' : 'none';
  document.getElementById('q2PriorityRow').style.opacity     = mode === 'priority' ? '1' : '0.3';
  document.getElementById('q2PriorityRow').style.pointerEvents = mode === 'priority' ? '' : 'none';

  stopQ2Priority();
  if (workletNode) {
    applyQ2Pattern(mode);
    if (mode === 'priority') startQ2Priority();
  }
}

function startQ2Priority() {
  stopQ2Priority();
  q2PrioritySub = 'wail';
  applyQ2Pattern('wail');
  scheduleQ2Priority();
}

function stopQ2Priority() {
  if (q2PriorityTimer) { clearTimeout(q2PriorityTimer); q2PriorityTimer = null; }
}

function scheduleQ2Priority() {
  if (!isPlaying || synthMode !== 'q2' || q2Mode !== 'priority') return;
  const cycleMs = getVal('q2CycleTime') * 1000;
  const coastMs = 200;

  if (q2PrioritySub === 'wail') {
    q2PriorityTimer = setTimeout(() => {
      q2PrioritySub = 'coast';
      if (workletNode) workletNode.parameters.get('wailDepth').value = 0;
      scheduleQ2Priority();
    }, cycleMs);
  } else if (q2PrioritySub === 'coast') {
    q2PriorityTimer = setTimeout(() => {
      q2PrioritySub = 'yelp';
      applyQ2Pattern('yelp');
      scheduleQ2Priority();
    }, coastMs);
  } else if (q2PrioritySub === 'yelp') {
    q2PriorityTimer = setTimeout(() => {
      q2PrioritySub = 'coast2';
      if (workletNode) workletNode.parameters.get('wailDepth').value = 0;
      scheduleQ2Priority();
    }, cycleMs);
  } else if (q2PrioritySub === 'coast2') {
    q2PriorityTimer = setTimeout(() => {
      q2PrioritySub = 'wail';
      applyQ2Pattern('wail');
      scheduleQ2Priority();
    }, coastMs);
  }
}

// ── Teardown source nodes ─────────────────────────────────────────────────────
function teardownSourceNodes() {
  clearTimeout(twoToneTimeout); twoToneTimeout = null;
  stopQ2Priority();
  const safe = (n, fn) => { if (n) { try { n[fn](); } catch(e){} } };
  safe(workletNode,     'disconnect'); workletNode     = null;
  safe(noiseSource,     'stop');       noiseSource     = null;
  safe(electronicOsc,   'stop');       electronicOsc   = null;
  safe(electronicHumOsc,'stop');       electronicHumOsc= null;
  safe(twoToneOsc,      'stop');       twoToneOsc      = null;
  elecBPF1 = null; elecBPF2 = null; elecHumGain = null;
  q2PhaserGain = null; twoToneGapGain = null;
}

// ── Audio setup ───────────────────────────────────────────────────────────────
async function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!moduleLoaded) {
    await audioCtx.audioWorklet.addModule('siren-processor.js');
    moduleLoaded = true;
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0;
    scopeBuffer = new Float32Array(analyserNode.fftSize);
    streamDest = audioCtx.createMediaStreamDestination();
    analyserNode.connect(audioCtx.destination);
    analyserNode.connect(streamDest);
  }
}

async function startPlayback() {
  await ensureAudio();
  teardownSourceNodes();
  buildSharedChain();

  if      (synthMode === 'mechanical') buildMechanicalChain();
  else if (synthMode === 'q2')         buildQ2Chain();
  else if (synthMode === 'electronic') buildElectronicChain();
  else if (synthMode === 'twotone')    buildTwoToneChain();

  startTime = audioCtx.currentTime;
  isPlaying = true;
  setStatus('on', 'RUNNING');
  document.getElementById('playBtn').textContent = '⏹ STOP';
  document.getElementById('playBtn').classList.add('active');
  if (!animFrame) animate();
}

function stopPlayback() {
  teardownSourceNodes();
  isPlaying = false;
  setStatus('', 'OFFLINE');
  document.getElementById('playBtn').textContent = '▶ PLAY';
  document.getElementById('playBtn').classList.remove('active');
}

async function togglePlay() {
  if (isPlaying) stopPlayback(); else await startPlayback();
}

// ── Synthesis mode switch ─────────────────────────────────────────────────────
const MODE_TAGLINES = {
  mechanical: 'Mechanical Rotary Siren Synthesizer',
  q2:         'Federal Signal Q2 · Wail / Yelp / Phaser / Priority',
  electronic: 'Electronic Siren · Oscillator + Horn Speaker Model',
  twotone:    'Two-Tone Hi-Lo · European Emergency Services',
};

function setSynthMode(mode) {
  const wasPlaying = isPlaying;
  if (wasPlaying) stopPlayback();
  synthMode = mode;

  // Update tabs
  ['mechanical','q2','electronic','twotone'].forEach(m =>
    document.getElementById('modeTab_' + m).classList.toggle('active', m === mode)
  );
  document.getElementById('tagline').textContent = MODE_TAGLINES[mode] || '';

  // Panel visibility
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  };
  show('panelDisk',       mode !== 'twotone');
  show('panelRing2',      mode === 'mechanical');
  show('panelWail',       mode === 'mechanical' || mode === 'electronic');
  show('panelQ2',         mode === 'q2');
  show('panelElectronic', mode === 'electronic');
  show('panelTwoTone',    mode === 'twotone');
  show('presetsBar',      mode === 'mechanical');
  show('pitchBtn',        mode !== 'twotone');

  // Math panel rows
  const isTT = mode === 'twotone';
  show('mathMechanical',    !isTT);
  show('mathStats',         !isTT);
  show('mathRing2Row',      false); // will re-evaluate in animate()
  show('mathTwoTone',       isTT);
  show('mathTwoToneStats',  isTT);

  if (wasPlaying) startPlayback();
}

// ── Status indicator ──────────────────────────────────────────────────────────
function setStatus(cls, text) {
  document.getElementById('statusLight').className = 'status-light' + (cls ? ' ' + cls : '');
  document.getElementById('statusText').textContent = text;
}

// ── Wail maths (used by mechanical + q2 + electronic) ────────────────────────
function wailMod(phase) {
  switch (currentWailShape) {
    case 1: return 1 - 4 * Math.abs(phase - 0.5);
    case 2: return 2 * phase - 1;
    default: return Math.sin(2 * Math.PI * phase);
  }
}

function getCurrentRPM() {
  if (!isPlaying || !audioCtx) return 0;
  const elapsed  = audioCtx.currentTime - startTime;
  const wailRate = getVal('wailRate') / 100;
  const phase    = (elapsed * wailRate) % 1;
  return Math.max(0, getVal('baseRPM') + getVal('wailDepth') * wailMod(phase));
}

function getCurrentFreq() {
  if (synthMode === 'twotone') return twoToneCurrentHz;
  return getVal('holes') * getCurrentRPM() / 60;
}

// ── Pitch lock ────────────────────────────────────────────────────────────────
function pitchLock() {
  const freq = getCurrentFreq();
  if (freq <= 0) return;
  const n = Math.round(12 * Math.log2(freq / 440));
  const targetFreq = 440 * Math.pow(2, n / 12);
  const targetRPM  = Math.round(Math.max(100, Math.min(6000, targetFreq * 60 / getVal('holes'))));
  setVal('baseRPM', targetRPM);
  if (workletNode) workletNode.parameters.get('baseRPM').value = targetRPM;
}

// ── Hole / wail shape UI ──────────────────────────────────────────────────────
function setHoleShape(shape) {
  currentHoleShape = shape === 'slot' ? 1 : 0;
  document.getElementById('shapeRound').classList.toggle('active', shape === 'round');
  document.getElementById('shapeSlot').classList.toggle('active',  shape === 'slot');
  document.getElementById('skewRow').style.opacity       = shape === 'slot' ? '1' : '0.35';
  document.getElementById('skewRow').style.pointerEvents = shape === 'slot' ? '' : 'none';
  if (workletNode) workletNode.parameters.get('holeShape').value = currentHoleShape;
}

function setWailShape(n) {
  currentWailShape = n;
  ['wailSine','wailTri','wailSaw'].forEach((id, i) =>
    document.getElementById(id).classList.toggle('active', i === n)
  );
  if (workletNode) workletNode.parameters.get('wailShape').value = n;
}

function onRing2Toggle() {
  const enabled = document.getElementById('ring2enabled').checked;
  document.getElementById('ring2body').classList.toggle('dim', !enabled);
  if (workletNode) workletNode.parameters.get('ring2enabled').value = enabled ? 1 : 0;
}

// ── Mechanical presets ────────────────────────────────────────────────────────
const PRESETS = {
  airRaid:    { holes:6,  baseRPM:1800, wailDepth:900,  wailRate:50,  dutyCycle:50, holeShape:'round', slotSkew:50, wailShape:0, ring2:false },
  policeYelp: { holes:8,  baseRPM:2400, wailDepth:400,  wailRate:180, dutyCycle:38, holeShape:'round', slotSkew:50, wailShape:2, ring2:false },
  european:   { holes:6,  baseRPM:1200, wailDepth:600,  wailRate:80,  dutyCycle:50, holeShape:'slot',  slotSkew:60, wailShape:0, ring2:false },
  tornado:    { holes:12, baseRPM:2400, wailDepth:1400, wailRate:25,  dutyCycle:45, holeShape:'slot',  slotSkew:70, wailShape:1, ring2:false },
  steady:     { holes:6,  baseRPM:2200, wailDepth:0,    wailRate:50,  dutyCycle:50, holeShape:'round', slotSkew:50, wailShape:0, ring2:false },
  chord:      { holes:6,  baseRPM:1800, wailDepth:700,  wailRate:50,  dutyCycle:50, holeShape:'round', slotSkew:50, wailShape:0, ring2:true, ring2holes:9 },
};

function loadPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  setVal('holes',     p.holes);
  setVal('baseRPM',   p.baseRPM);
  setVal('wailDepth', p.wailDepth);
  setVal('wailRate',  p.wailRate);
  setVal('dutyCycle', p.dutyCycle);
  setVal('slotSkew',  p.slotSkew);
  setHoleShape(p.holeShape);
  setWailShape(p.wailShape);
  document.getElementById('ring2enabled').checked = !!p.ring2;
  onRing2Toggle();
  if (p.ring2holes) setVal('ring2holes', p.ring2holes);
  updateAllParams();
}

// ── Electronic horn presets ───────────────────────────────────────────────────
const ELEC_PRESETS = {
  federal3900: { peak1: 580, peak2: 1850, hum: 25 },
  whelen:      { peak1: 650, peak2: 2100, hum: 15 },
  generic:     { peak1: 600, peak2: 1800, hum: 20 },
};

function loadElecPreset(name) {
  const p = ELEC_PRESETS[name]; if (!p) return;
  setVal('elecPeak1', p.peak1);
  setVal('elecPeak2', p.peak2);
  setVal('elecHum',   p.hum);
  if (elecBPF1) elecBPF1.frequency.value = p.peak1;
  if (elecBPF2) elecBPF2.frequency.value = p.peak2;
  if (elecHumGain) elecHumGain.gain.value = p.hum / 100 * 0.04;
}

// ── Two-tone country presets ──────────────────────────────────────────────────
const TT_COUNTRIES = {
  uk:      { lo: 500, hi: 660, loDur: 500, hiDur: 500, gap: 0   },
  ukyam:   { lo: 470, hi: 770, loDur: 450, hiDur: 450, gap: 30  },
  france:  { lo: 440, hi: 554, loDur: 480, hiDur: 480, gap: 20  },
  germany: { lo: 392, hi: 524, loDur: 520, hiDur: 520, gap: 10  },
};

function loadTTCountry(name) {
  const p = TT_COUNTRIES[name]; if (!p) return;
  setVal('ttLowHz',  p.lo);
  setVal('ttHighHz', p.hi);
  setVal('ttLowDur', p.loDur);
  setVal('ttHighDur',p.hiDur);
  setVal('ttGap',    p.gap);
  // Restart sequencer with new values if playing
  if (isPlaying && synthMode === 'twotone') startTwoToneSequencer();
}

// ── Recording ─────────────────────────────────────────────────────────────────
async function startRecording() {
  if (isRecording) return;
  if (!isPlaying) await startPlayback();
  const duration = parseInt(document.getElementById('recDuration').value);
  const mimeType = MediaRecorder.isTypeSupported('audio/ogg; codecs=opus')
    ? 'audio/ogg; codecs=opus'
    : (MediaRecorder.isTypeSupported('audio/webm; codecs=opus') ? 'audio/webm; codecs=opus' : 'audio/webm');
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  recChunks = [];
  mediaRecorder = new MediaRecorder(streamDest.stream, { mimeType });
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recChunks, { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `siren-lab-${Date.now()}.${ext}`; a.click();
    URL.revokeObjectURL(url);
    isRecording = false;
    document.getElementById('recBtn').classList.remove('active');
    document.getElementById('recStatus').textContent = '✓ saved';
    setStatus('on', 'RUNNING');
    setTimeout(() => { document.getElementById('recStatus').textContent = ''; }, 3000);
  };
  mediaRecorder.start();
  isRecording = true;
  document.getElementById('recBtn').classList.add('active');
  setStatus('rec', 'RECORDING');
  recCountdown = duration;
  document.getElementById('recStatus').textContent = `${recCountdown}s`;
  recTimer = setInterval(() => {
    recCountdown--;
    document.getElementById('recStatus').textContent = recCountdown > 0 ? `${recCountdown}s` : '';
    if (recCountdown <= 0) { clearInterval(recTimer); mediaRecorder.stop(); }
  }, 1000);
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animate() {
  animFrame = requestAnimationFrame(animate);
  frameCount++;

  // Drive electronic osc frequency from wail controls
  if (isPlaying && synthMode === 'electronic' && electronicOsc && audioCtx) {
    const f = Math.max(20, getCurrentFreq());
    electronicOsc.frequency.setTargetAtTime(f, audioCtx.currentTime, 0.01);
  }

  // Q2 phaser amplitude modulation (1.2 Hz, swings gain 0.4–1.0)
  if (isPlaying && synthMode === 'q2' && q2Mode === 'phaser' && q2PhaserGain && audioCtx) {
    const depth = getVal('q2PhaserDepth') / 100;
    const ph    = 1.2 * (audioCtx.currentTime - startTime);
    const mod   = 0.5 + 0.5 * Math.sin(2 * Math.PI * ph);
    q2PhaserGain.gain.setTargetAtTime(1 - depth * (1 - mod) * 0.6, audioCtx.currentTime, 0.005);
  }

  // Noise: gain ∝ RPM² and tracks pulse frequency
  if (noiseRPMGain && isPlaying) {
    const rpmFrac = Math.min(1, getCurrentRPM() / 6000);
    const amount  = fx.noise ? getVal('noiseAmount') / 100 : 0;
    noiseRPMGain.gain.value = amount * rpmFrac * rpmFrac * 0.5;
  }
  if (noiseBPF && isPlaying && audioCtx) {
    noiseBPF.frequency.setTargetAtTime(
      Math.max(100, getCurrentFreq() * 1.8), audioCtx.currentTime, 0.05
    );
  }

  drawGauge();
  drawScope();
  updateReadout();

  // Math display at ~15 fps (every 4 frames)
  if (frameCount % 4 === 0) updateMathDisplay();
}

// ── Math formula display ──────────────────────────────────────────────────────
function fmt1(n)  { return n.toFixed(1); }
function fmt0(n)  { return Math.round(n).toLocaleString(); }
function fmtMs(n) { return n.toFixed(1) + ' ms'; }

function updateMathDisplay() {
  if (synthMode === 'twotone') {
    const lo  = getVal('ttLowHz');
    const hi  = getVal('ttHighHz');
    const gap = getVal('ttGap');
    const cents = centsBetween(lo, hi);

    setText('mTTLo',     fmt0(lo)  + ' Hz');
    setText('mTTHi',     fmt0(hi)  + ' Hz');
    setText('mTTInterval', cents + ' \u00a2');
    setText('mTTLoDur',  fmt0(getVal('ttLowDur'))  + ' ms');
    setText('mTTHiDur',  fmt0(getVal('ttHighDur')) + ' ms');
    setText('mTTGap',    fmt0(gap) + ' ms');
    setText('mTTCycle',  fmt0(getVal('ttLowDur') + getVal('ttHighDur') + gap * 2) + ' ms');

    // Active tone indicator
    const isGap = twoToneCurrent.startsWith('gap');
    const tone  = twoToneCurrent === 'high' ? 'HI' : (isGap ? 'GAP' : 'LO');
    const el = document.getElementById('mTTActive');
    if (el) { el.textContent = tone + (isGap ? '' : ' \u25b6'); el.dataset.tone = tone; }
    return;
  }

  // Mechanical / Q2 / Electronic
  const rpm  = getCurrentRPM();
  const holes = getVal('holes');
  const freq  = holes * rpm / 60;
  const duty  = getVal('dutyCycle') / 100;

  setText('mHoles', String(Math.round(holes)));
  setText('mRPM',   fmt0(rpm));
  setText('mFreq',  freq > 0 ? fmt1(freq) + ' Hz' : '--');
  setText('mNote',  freq > 0 ? '\u2248 ' + freqToNote(freq) : '');

  if (freq > 0) {
    const T    = 1000 / freq;
    const open = T * duty;
    const disk = rpm > 0 ? 60000 / rpm : 0;
    setText('mPeriod', fmtMs(T));
    setText('mOpen',   fmtMs(open));
    setText('mDisk',   fmtMs(disk) + '/rev');
  }

  // Ring 2 beating (mechanical mode only)
  const ring2on = document.getElementById('ring2enabled').checked;
  const ring2row = document.getElementById('mathRing2Row');
  if (ring2row) {
    const show = synthMode === 'mechanical' && ring2on && freq > 0;
    ring2row.style.display = show ? '' : 'none';
    if (show) {
      const h2   = getVal('ring2holes');
      const f2   = h2 * rpm / 60;
      const beat = Math.abs(f2 - freq);
      setText('mR1',   fmt1(freq) + ' Hz');
      setText('mR2',   fmt1(f2)   + ' Hz');
      setText('mBeat', fmt1(beat) + ' Hz');
    }
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Gauge drawing ─────────────────────────────────────────────────────────────
function drawGauge() {
  const canvas = document.getElementById('gaugeCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 + 14, R = 90;
  const startA = Math.PI * 0.75, sweep = Math.PI * 1.5, maxRPM = 6000;

  ctx.clearRect(0, 0, W, H);

  ctx.beginPath(); ctx.arc(cx, cy, R, startA, startA + sweep);
  ctx.strokeStyle = '#222'; ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.stroke();

  const curRPM = synthMode === 'twotone' ? 0 : getCurrentRPM();
  const frac   = Math.min(1, curRPM / maxRPM);
  if (frac > 0) {
    const grad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
    grad.addColorStop(0, '#7c3412'); grad.addColorStop(1, '#f97316');
    ctx.beginPath(); ctx.arc(cx, cy, R, startA, startA + sweep * frac);
    ctx.strokeStyle = grad; ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.stroke();
  }

  ctx.lineCap = 'butt';
  for (let rpm = 0; rpm <= maxRPM; rpm += 500) {
    const angle = startA + (rpm / maxRPM) * sweep;
    const isMajor = rpm % 1000 === 0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * (R - (isMajor ? 20 : 10)), cy + Math.sin(angle) * (R - (isMajor ? 20 : 10)));
    ctx.lineTo(cx + Math.cos(angle) * (R + 7), cy + Math.sin(angle) * (R + 7));
    ctx.strokeStyle = isMajor ? '#555' : '#333'; ctx.lineWidth = isMajor ? 2 : 1; ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = '#555'; ctx.font = '9px Share Tech Mono';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(rpm === 0 ? '0' : (rpm / 1000) + 'k',
        cx + Math.cos(angle) * (R - 32), cy + Math.sin(angle) * (R - 32));
    }
  }

  const needleA = startA + sweep * frac;
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(needleA) * 12, cy - Math.sin(needleA) * 12);
  ctx.lineTo(cx + Math.cos(needleA) * (R - 18), cy + Math.sin(needleA) * (R - 18));
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.stroke();

  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI*2); ctx.fillStyle = '#f97316'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI*2); ctx.fillStyle = '#000'; ctx.fill();

  ctx.font = 'bold 22px Share Tech Mono'; ctx.fillStyle = '#e8e8e8';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  if (synthMode === 'twotone') {
    // Show current two-tone frequency instead of RPM
    const isLo = twoToneCurrent === 'low';
    const isHi = twoToneCurrent === 'high';
    ctx.fillText(isLo ? 'LO' : (isHi ? 'HI' : '···'), cx, cy + 30);
    ctx.font = '9px Barlow Condensed'; ctx.fillStyle = '#444';
    ctx.fillText(fmt1(twoToneCurrentHz) + ' Hz', cx, cy + 46);
  } else {
    ctx.fillText(fmt0(curRPM), cx, cy + 30);
    ctx.font = '9px Barlow Condensed'; ctx.fillStyle = '#444';
    ctx.fillText('RPM', cx, cy + 46);
  }
}

// ── Scope drawing ─────────────────────────────────────────────────────────────
function drawScope() {
  const canvas = document.getElementById('scopeCanvas');
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#151515'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += W / 8) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y <= H; y += H / 4) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  ctx.strokeStyle = '#1e1e1e';
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

  if (!analyserNode || !isPlaying || !scopeBuffer) return;
  analyserNode.getFloatTimeDomainData(scopeBuffer);

  let startIdx = 0;
  for (let i = 1; i < scopeBuffer.length - 1; i++) {
    if (scopeBuffer[i-1] < 0 && scopeBuffer[i] >= 0) { startIdx = i; break; }
  }
  const drawLen = Math.min(scopeBuffer.length - startIdx, Math.floor(scopeBuffer.length * 0.6));

  ctx.beginPath(); ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1.5;
  ctx.shadowColor = '#f97316'; ctx.shadowBlur = 4;
  for (let i = 0; i < drawLen; i++) {
    const x = (i / drawLen) * W;
    const y = H / 2 - scopeBuffer[startIdx + i] * H * 0.45;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

// ── Readout bar ───────────────────────────────────────────────────────────────
function updateReadout() {
  const freq = isPlaying ? getCurrentFreq() : 0;
  const rpm  = isPlaying ? (synthMode === 'twotone' ? 0 : getCurrentRPM()) : 0;
  setText('readFreq', isPlaying ? fmt1(freq) + ' Hz' : '-- Hz');
  setText('readNote', isPlaying ? freqToNote(freq) : '--');
  setText('readRPM',  isPlaying && synthMode !== 'twotone' ? fmt0(rpm) : '--');
}

// ── Slider binding ────────────────────────────────────────────────────────────
function bindSliders() {
  const defs = [
    ['holes',       v => String(Math.round(v)),          'holesVal'],
    ['baseRPM',     v => String(Math.round(v)),          'baseRPMVal'],
    ['wailDepth',   v => Math.round(v) + ' RPM',        'wailDepthVal'],
    ['wailRate',    v => (v/100).toFixed(2) + ' Hz',    'wailRateVal'],
    ['dutyCycle',   v => Math.round(v) + '%',           'dutyCycleVal'],
    ['slotSkew',    v => Math.round(v) + '%',           'slotSkewVal'],
    ['volume',      v => Math.round(v) + '%',           'volumeVal'],
    ['ring2holes',  v => String(Math.round(v)),          'ring2holesVal'],
    ['satDrive',    v => parseFloat(v).toFixed(1) + 'x', 'satDriveVal'],
    ['noiseAmount', v => Math.round(v) + '%',           'noiseAmountVal'],
    ['q2PhaserDepth', v => Math.round(v) + '%',         'q2PhaserDepthVal'],
    ['q2CycleTime', v => parseFloat(v).toFixed(1) + ' s','q2CycleTimeVal'],
    ['elecPeak1',   v => Math.round(v) + ' Hz',         'elecPeak1Val'],
    ['elecPeak2',   v => Math.round(v) + ' Hz',         'elecPeak2Val'],
    ['elecHum',     v => Math.round(v) + '%',           'elecHumVal'],
    ['ttLowHz',     v => Math.round(v) + ' Hz',         'ttLowHzVal'],
    ['ttHighHz',    v => Math.round(v) + ' Hz',         'ttHighHzVal'],
    ['ttLowDur',    v => Math.round(v) + ' ms',         'ttLowDurVal'],
    ['ttHighDur',   v => Math.round(v) + ' ms',         'ttHighDurVal'],
    ['ttGap',       v => Math.round(v) + ' ms',         'ttGapVal'],
    ['hornTuning',  v => {
      const shift = parseFloat(v) / 100;
      const bases = [700, 2100, 4400];
      hornBPFs.forEach((bpf, i) => { bpf.frequency.value = bases[i] * (1 + shift * 0.5); });
      return (shift >= 0 ? '+' : '') + Math.round(shift * 50) + '%';
    }, 'hornTuningVal'],
  ];

  defs.forEach(([id, fmt, valId]) => {
    const slider = document.getElementById(id);
    const label  = document.getElementById(valId);
    if (!slider || !label) return;
    const update = () => {
      label.textContent = fmt(slider.value);
      // Live-update audio nodes where applicable
      if (id === 'satDrive') updateSatCurve();
      if (id === 'volume' && workletNode) workletNode.parameters.get('volume').value = slider.value / 100;
      if (id === 'elecPeak1' && elecBPF1)     elecBPF1.frequency.value  = parseFloat(slider.value);
      if (id === 'elecPeak2' && elecBPF2)     elecBPF2.frequency.value  = parseFloat(slider.value);
      if (id === 'elecHum'   && elecHumGain)  elecHumGain.gain.value     = parseFloat(slider.value) / 100 * 0.04;
      if ((id === 'baseRPM' || id === 'wailDepth' || id === 'wailRate') && workletNode) updateAllParams();
      if (id === 'holes'    && workletNode) workletNode.parameters.get('holes').value     = parseFloat(slider.value);
      if (id === 'dutyCycle' && workletNode) workletNode.parameters.get('dutyCycle').value = parseFloat(slider.value) / 100;
      if (id === 'ring2holes' && workletNode) workletNode.parameters.get('ring2holes').value = parseFloat(slider.value);
    };
    slider.addEventListener('input', update);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  bindSliders();
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (isSafari) document.getElementById('safariWarning').style.display = '';
  setHoleShape('round');
  updateMathDisplay();
  animate();
}

document.addEventListener('DOMContentLoaded', init);
