/**
 * Siren Lab — Main Application
 * Controls Web Audio API synthesis, visualizers, recording, and UI state.
 *
 * Signal chain:
 *   workletNode
 *     ├─[satDryGain]────────────────────────────────► [postSat]
 *     └─[satDriveGain]─[waveShaper]─[satWetGain]───► [postSat]
 *
 *   noiseSource─[noiseBPF]─[noiseRPMGain]─[noiseEnableGain]─► [postSat]
 *
 *   [postSat]─────────────────────────────────────────────────► [postHorn]
 *   [postSat]─[hornBPF1]─┐
 *   [postSat]─[hornBPF2]─┼─[hornBoostGain]──────────────────► [postHorn]
 *   [postSat]─[hornBPF3]─┘
 *
 *   [postHorn]─[analyserNode]─► destination + streamDest
 */

'use strict';

// ── Audio state ──────────────────────────────────────────────────────────────
let audioCtx        = null;
let workletNode     = null;
let analyserNode    = null;
let streamDest      = null;
let moduleLoaded    = false;
let isPlaying       = false;
let isRecording     = false;
let startTime       = 0;

// Effect nodes (rebuilt each startPlayback)
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

// Effect state (persists across play/stop cycles)
const fx = { noise: false, horn: false, sat: false };

// UI state
let currentWailShape = 0;
let currentHoleShape = 0;

// Animation / recording
let animFrame    = null;
let scopeBuffer  = null;
let mediaRecorder = null;
let recChunks    = [];
let recTimer     = null;
let recCountdown = 0;

// ── Note names ───────────────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function freqToNote(freq) {
  if (!freq || freq <= 0) return '-';
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  if (midi < 0 || midi > 127) return '-';
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

// ── Param helpers ────────────────────────────────────────────────────────────
function getVal(id) { return parseFloat(document.getElementById(id).value); }

function setVal(id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

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

// ── Waveshaper curve (tanh soft-clip) ────────────────────────────────────────
function makeTanhCurve(drive, samples = 512) {
  const curve = new Float32Array(samples);
  const norm  = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

// ── Smooth gain ramp (avoids zipper noise when toggling) ─────────────────────
function rampGain(gainNode, target, seconds) {
  if (!audioCtx || !gainNode) return;
  gainNode.gain.linearRampToValueAtTime(target, audioCtx.currentTime + (seconds || 0.025));
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
    // hornBoostGain adds resonant peaks on top of the always-present dry signal
    rampGain(hornBoostGain, enabled ? 0.4 : 0);
    document.getElementById('hornTuningRow').classList.toggle('dim', !enabled);
  }

  if (name === 'noise') {
    rampGain(noiseEnableGain, enabled ? 1 : 0);
    document.getElementById('noiseAmountRow').classList.toggle('dim', !enabled);
  }
}

function updateSatCurve() {
  if (!waveShaper) return;
  waveShaper.curve = makeTanhCurve(getVal('satDrive'));
}

// ── Build effect chain ────────────────────────────────────────────────────────
function buildEffectChain() {

  // ── Saturation stage ──────────────────────────────────────────────────────
  satDryGain = audioCtx.createGain();
  satDryGain.gain.value = fx.sat ? 0 : 1;

  satDriveGain = audioCtx.createGain();
  satDriveGain.gain.value = 1;

  waveShaper = audioCtx.createWaveShaper();
  waveShaper.curve = makeTanhCurve(getVal('satDrive'));
  waveShaper.oversample = '4x';

  satWetGain = audioCtx.createGain();
  satWetGain.gain.value = fx.sat ? 1 : 0;

  postSat = audioCtx.createGain(); // summing bus
  postSat.gain.value = 1;

  workletNode.connect(satDryGain);
  workletNode.connect(satDriveGain);
  satDriveGain.connect(waveShaper);
  waveShaper.connect(satWetGain);
  satDryGain.connect(postSat);
  satWetGain.connect(postSat);

  // ── Noise stage ───────────────────────────────────────────────────────────
  const bufLen    = Math.floor(audioCtx.sampleRate * 2);
  const noiseBuf  = audioCtx.createBuffer(1, bufLen, audioCtx.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) noiseData[i] = Math.random() * 2 - 1;

  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = noiseBuf;
  noiseSource.loop   = true;

  noiseBPF = audioCtx.createBiquadFilter();
  noiseBPF.type            = 'bandpass';
  noiseBPF.frequency.value = 600;
  noiseBPF.Q.value         = 1.2;

  noiseRPMGain = audioCtx.createGain();
  noiseRPMGain.gain.value = 0; // driven in animate()

  noiseEnableGain = audioCtx.createGain();
  noiseEnableGain.gain.value = fx.noise ? 1 : 0;

  noiseSource.connect(noiseBPF);
  noiseBPF.connect(noiseRPMGain);
  noiseRPMGain.connect(noiseEnableGain);
  noiseEnableGain.connect(postSat); // noise goes through horn stage too

  noiseSource.start();

  // ── Horn stage ────────────────────────────────────────────────────────────
  postHorn = audioCtx.createGain();
  postHorn.gain.value = 1;

  hornBoostGain = audioCtx.createGain();
  hornBoostGain.gain.value = fx.horn ? 0.4 : 0;

  const hornFreqs = [700, 2100, 4400];
  const hornQs    = [3.5, 4.0, 3.0];

  hornBPFs = hornFreqs.map((f, i) => {
    const bpf = audioCtx.createBiquadFilter();
    bpf.type            = 'bandpass';
    bpf.frequency.value = f;
    bpf.Q.value         = hornQs[i];
    postSat.connect(bpf);
    bpf.connect(hornBoostGain);
    return bpf;
  });

  // Dry always present; boost layer added when horn is on
  postSat.connect(postHorn);
  hornBoostGain.connect(postHorn);

  // ── Output ────────────────────────────────────────────────────────────────
  postHorn.connect(analyserNode);

  // Sync dim state for effect sub-controls
  document.getElementById('satDriveRow').classList.toggle('dim', !fx.sat);
  document.getElementById('hornTuningRow').classList.toggle('dim', !fx.horn);
  document.getElementById('noiseAmountRow').classList.toggle('dim', !fx.noise);
}

// ── Audio setup ───────────────────────────────────────────────────────────────
async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
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

  if (workletNode)  { workletNode.disconnect(); workletNode = null; }
  if (noiseSource)  { try { noiseSource.stop(); } catch(e){} noiseSource = null; }

  workletNode = new AudioWorkletNode(audioCtx, 'siren-processor');
  buildEffectChain();
  updateAllParams();

  startTime = audioCtx.currentTime;
  isPlaying = true;

  setStatus('on', 'RUNNING');
  document.getElementById('playBtn').textContent = 'STOP';
  document.getElementById('playBtn').classList.add('active');

  if (!animFrame) animate();
}

function stopPlayback() {
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (noiseSource) { try { noiseSource.stop(); } catch(e){} noiseSource = null; }
  isPlaying = false;
  setStatus('', 'OFFLINE');
  document.getElementById('playBtn').textContent = 'PLAY';
  document.getElementById('playBtn').classList.remove('active');
}

async function togglePlay() {
  if (isPlaying) stopPlayback();
  else await startPlayback();
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(cls, text) {
  const light = document.getElementById('statusLight');
  const label = document.getElementById('statusText');
  light.className = 'status-light' + (cls ? ' ' + cls : '');
  label.textContent = text;
}

// ── Waveform maths ────────────────────────────────────────────────────────────
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

// ── UI toggles ────────────────────────────────────────────────────────────────
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

// ── Presets ───────────────────────────────────────────────────────────────────
const PRESETS = {
  airRaid:    { holes:6,  baseRPM:1800, wailDepth:900,  wailRate:50,  dutyCycle:50, holeShape:'round', slotSkew:50, wailShape:0, ring2:false },
  policeYelp: { holes:8,  baseRPM:2400, wailDepth:400,  wailRate:180, dutyCycle:38, holeShape:'round', slotSkew:50, wailShape:2, ring2:false },
  european:   { holes:6,  baseRPM:1200, wailDepth:600,  wailRate:80,  dutyCycle:50, holeShape:'slot',  slotSkew:60, wailShape:0, ring2:false },
  tornado:    { holes:12, baseRPM:2400, wailDepth:1400, wailRate:25,  dutyCycle:45, holeShape:'slot',  slotSkew:70, wailShape:1, ring2:false },
  steady:     { holes:6,  baseRPM:2200, wailDepth:0,    wailRate:50,  dutyCycle:50, holeShape:'round', slotSkew:50, wailShape:0, ring2:false },
  chord:      { holes:6,  baseRPM:1800, wailDepth:700,  wailRate:50,  dutyCycle:50, holeShape:'round', slotSkew:50, wailShape:0, ring2:true, ring2holes:9 },
};

function loadPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  setVal('holes',     p.holes);
  setVal('baseRPM',   p.baseRPM);
  setVal('wailDepth', p.wailDepth);
  setVal('wailRate',  p.wailRate);
  setVal('dutyCycle', p.dutyCycle);
  setVal('slotSkew',  p.slotSkew);
  setHoleShape(p.holeShape);
  setWailShape(p.wailShape);
  const ring2cb = document.getElementById('ring2enabled');
  ring2cb.checked = !!p.ring2;
  onRing2Toggle();
  if (p.ring2holes) setVal('ring2holes', p.ring2holes);
  updateAllParams();
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
    document.getElementById('recStatus').textContent = 'saved';
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

  // Noise gain: scales with RPM squared so it's subtle at low speed, prominent at high
  if (noiseRPMGain && isPlaying) {
    const rpmFrac = Math.min(1, getCurrentRPM() / 6000);
    const amount  = fx.noise ? getVal('noiseAmount') / 100 : 0;
    noiseRPMGain.gain.value = amount * rpmFrac * rpmFrac * 0.5;
  } else if (noiseRPMGain) {
    noiseRPMGain.gain.value = 0;
  }

  // Noise BPF tracks 1.8× the pulse frequency (turbulence sits above fundamental)
  if (noiseBPF && isPlaying && audioCtx) {
    const f = Math.max(100, getCurrentFreq() * 1.8);
    noiseBPF.frequency.setTargetAtTime(f, audioCtx.currentTime, 0.05);
  }

  drawGauge();
  drawScope();
  updateReadout();
}

// ── Gauge ─────────────────────────────────────────────────────────────────────
function drawGauge() {
  const canvas = document.getElementById('gaugeCanvas');
  const ctx    = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 + 14;
  const R  = 90;
  const startA = Math.PI * 0.75;
  const sweep  = Math.PI * 1.5;
  const maxRPM = 6000;

  ctx.clearRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(cx, cy, R, startA, startA + sweep);
  ctx.strokeStyle = '#222'; ctx.lineWidth = 14; ctx.lineCap = 'round';
  ctx.stroke();

  const curRPM = getCurrentRPM();
  const frac   = Math.min(1, curRPM / maxRPM);
  if (frac > 0) {
    const grad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
    grad.addColorStop(0, '#7c3412'); grad.addColorStop(1, '#f97316');
    ctx.beginPath();
    ctx.arc(cx, cy, R, startA, startA + sweep * frac);
    ctx.strokeStyle = grad; ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.stroke();
  }

  ctx.lineCap = 'butt';
  for (let rpm = 0; rpm <= maxRPM; rpm += 500) {
    const angle   = startA + (rpm / maxRPM) * sweep;
    const isMajor = rpm % 1000 === 0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * (R - (isMajor ? 20 : 10)), cy + Math.sin(angle) * (R - (isMajor ? 20 : 10)));
    ctx.lineTo(cx + Math.cos(angle) * (R + 7), cy + Math.sin(angle) * (R + 7));
    ctx.strokeStyle = isMajor ? '#555' : '#333'; ctx.lineWidth = isMajor ? 2 : 1;
    ctx.stroke();
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
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fillStyle = '#f97316'; ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = '#000';    ctx.fill();

  ctx.font = 'bold 22px Share Tech Mono'; ctx.fillStyle = '#e8e8e8';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(curRPM).toLocaleString(), cx, cy + 30);
  ctx.font = '9px Barlow Condensed'; ctx.fillStyle = '#444';
  ctx.fillText('RPM', cx, cy + 46);
}

// ── Oscilloscope ──────────────────────────────────────────────────────────────
function drawScope() {
  const canvas = document.getElementById('scopeCanvas');
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#080808';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#151515'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += W / 8) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y <= H; y += H / 4) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  ctx.strokeStyle = '#1e1e1e';
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

  if (!analyserNode || !isPlaying || !scopeBuffer) return;

  analyserNode.getFloatTimeDomainData(scopeBuffer);

  let startIdx = 0;
  for (let i = 1; i < scopeBuffer.length - 1; i++) {
    if (scopeBuffer[i - 1] < 0 && scopeBuffer[i] >= 0) { startIdx = i; break; }
  }

  const drawLen = Math.min(scopeBuffer.length - startIdx, Math.floor(scopeBuffer.length * 0.6));

  ctx.beginPath();
  ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1.5;
  ctx.shadowColor = '#f97316'; ctx.shadowBlur = 4;
  for (let i = 0; i < drawLen; i++) {
    const x = (i / drawLen) * W;
    const y = H / 2 - scopeBuffer[startIdx + i] * H * 0.45;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ── Readout ───────────────────────────────────────────────────────────────────
function updateReadout() {
  const freq = getCurrentFreq();
  const rpm  = getCurrentRPM();
  document.getElementById('readFreq').textContent = isPlaying ? freq.toFixed(1) + ' Hz' : '-- Hz';
  document.getElementById('readNote').textContent = isPlaying ? freqToNote(freq) : '--';
  document.getElementById('readRPM').textContent  = isPlaying ? Math.round(rpm).toLocaleString() : '--';
}

// ── Slider binding ────────────────────────────────────────────────────────────
function bindSliders() {
  const bindings = [
    ['holes',       v => `${Math.round(v)}`,             'holesVal'],
    ['baseRPM',     v => `${Math.round(v)}`,             'baseRPMVal'],
    ['wailDepth',   v => `${Math.round(v)} RPM`,         'wailDepthVal'],
    ['wailRate',    v => `${(v/100).toFixed(2)} Hz`,     'wailRateVal'],
    ['dutyCycle',   v => `${Math.round(v)}%`,            'dutyCycleVal'],
    ['slotSkew',    v => `${Math.round(v)}%`,            'slotSkewVal'],
    ['volume',      v => `${Math.round(v)}%`,            'volumeVal'],
    ['ring2holes',  v => `${Math.round(v)}`,             'ring2holesVal'],
    ['satDrive',    v => `${parseFloat(v).toFixed(1)}x`, 'satDriveVal'],
    ['noiseAmount', v => `${Math.round(v)}%`,            'noiseAmountVal'],
    ['hornTuning',  v => {
      // Shift all horn BPF center frequencies up/down proportionally
      const shift = parseFloat(v) / 100;
      const bases = [700, 2100, 4400];
      if (hornBPFs.length === 3) {
        hornBPFs.forEach((bpf, i) => {
          bpf.frequency.value = bases[i] * (1 + shift * 0.5);
        });
      }
      return shift >= 0 ? `+${Math.round(shift*50)}%` : `${Math.round(shift*50)}%`;
    }, 'hornTuningVal'],
  ];

  bindings.forEach(([id, fmt, valId]) => {
    const slider = document.getElementById(id);
    if (!slider) return;
    const label  = document.getElementById(valId);
    const update = () => {
      label.textContent = fmt(slider.value);
      if (workletNode) updateAllParams();
      if (id === 'satDrive') updateSatCurve();
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
  animate();
}

document.addEventListener('DOMContentLoaded', init);
