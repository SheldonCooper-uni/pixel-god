import { E, MATERIALS } from './elements.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const hud = document.getElementById('hud');
const hud2 = document.getElementById('hud2');

const selTool = document.getElementById('tool');
const selMat  = document.getElementById('material');
const rngBrush = document.getElementById('brush');
const brushVal = document.getElementById('brushVal');
const rngStrength = document.getElementById('strength');
const strengthVal = document.getElementById('strengthVal');
const rngTurb = document.getElementById('turb');
const turbVal = document.getElementById('turbVal');
const rngWindAngle = document.getElementById('windAngle');
const windAngleVal = document.getElementById('windAngleVal');
const selQuality = document.getElementById('quality');
const chkQualityAuto = document.getElementById('qualityAuto');
const btnClear = document.getElementById('clear');
const btnPause = document.getElementById('pause');

for (const m of MATERIALS) {
  const opt = document.createElement('option');
  opt.value = String(m.id);
  opt.textContent = m.name;
  selMat.appendChild(opt);
}
selMat.value = String(E.SAND);

brushVal.textContent = rngBrush.value;
strengthVal.textContent = rngStrength.value;
turbVal.textContent = rngTurb.value;
windAngleVal.textContent = rngWindAngle.value;

// Device pixel ratio (cap at 2)
const QUALITY_LEVELS = {
  low:    { w: 480,  h: 270,  brushMax: 30 },
  medium: { w: 640,  h: 360,  brushMax: 60 },
  high:   { w: 960,  h: 540,  brushMax: 60 },
  ultra:  { w: 1280, h: 720,  brushMax: 60 },
};

let currentQuality = (selQuality?.value || 'medium');
if (!(currentQuality in QUALITY_LEVELS)) currentQuality = 'medium';

let simW = QUALITY_LEVELS[currentQuality].w;
let simH = QUALITY_LEVELS[currentQuality].h;

let worker;

function disableImageSmoothing(c) {
  // Standard + legacy vendor aliases (harmless where unsupported)
  c.imageSmoothingEnabled = false;
  c.mozImageSmoothingEnabled = false;
  c.webkitImageSmoothingEnabled = false;
  c.msImageSmoothingEnabled = false;
}

function layoutCanvasIntegerScale() {
  // Keep simulation resolution fixed (canvas backing store), and only scale via CSS.
  canvas.width = simW;
  canvas.height = simH;

  const availW = window.innerWidth;
  const availH = window.innerHeight;
  const scale = Math.max(1, Math.floor(Math.min(availW / simW, availH / simH)));

  const displayW = simW * scale;
  const displayH = simH * scale;

  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${displayH}px`;
  canvas.style.left = `${Math.floor((availW - displayW) / 2)}px`;
  canvas.style.top = `${Math.floor((availH - displayH) / 2)}px`;
}

disableImageSmoothing(ctx);
ctx.globalCompositeOperation = 'copy';

function applyQualityUIConstraints() {
  const q = QUALITY_LEVELS[currentQuality];
  if (!q) return;
  const max = q.brushMax;
  rngBrush.max = String(max);
  if (Number(rngBrush.value) > max) {
    rngBrush.value = String(max);
    brushVal.textContent = rngBrush.value;
  }
}

function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker('./simWorker.js', { type: 'module' });

  worker.onerror = (err) => {
    console.error('Worker error:', err.message, err.filename, err.lineno);
  };

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'frame') {
      ctx.drawImage(msg.bitmap, 0, 0);
      msg.bitmap.close?.();
      worker.postMessage({ type: 'frameAck' });
      return;
    }
    if (msg.type === 'hud') {
      hud.textContent = msg.text;
      hud2.textContent = msg.text2;
      onHudStats(msg);
    }
  };

  worker.postMessage({
    type: 'init',
    simW: simW,
    simH: simH,
  });

  // Push current UI state into the new worker.
  sendState();
}

function setQuality(nextQuality, reason = 'manual') {
  if (!(nextQuality in QUALITY_LEVELS)) return;
  if (nextQuality === currentQuality) return;
  currentQuality = nextQuality;
  if (selQuality) selQuality.value = currentQuality;
  simW = QUALITY_LEVELS[currentQuality].w;
  simH = QUALITY_LEVELS[currentQuality].h;
  applyQualityUIConstraints();
  layoutCanvasIntegerScale();
  startWorker();
}

layoutCanvasIntegerScale();
applyQualityUIConstraints();
window.addEventListener('resize', layoutCanvasIntegerScale);
startWorker();

let visualizeMode = 0; // 0 none, 1 wind speed, 2 vectors, 3 tracers
let isDown = false;
let last = null;
let lineMode = false;
let mouse = { x: 0, y: 0, inside: false };

function uiState() {
  const q = QUALITY_LEVELS[currentQuality];
  const brush = Math.min(Number(rngBrush.value), q?.brushMax ?? Number(rngBrush.value));
  return {
    tool: selTool.value,
    material: Number(selMat.value),
    brush,
    strength: Number(rngStrength.value),
    turb: Number(rngTurb.value),
    windAngle: Number(rngWindAngle.value),
    visualize: visualizeMode,
  };
}

function sendState() {
  worker.postMessage({ type: 'state', state: uiState() });
}

selTool.addEventListener('change', sendState);
selMat.addEventListener('change', sendState);

rngBrush.addEventListener('input', () => { brushVal.textContent = rngBrush.value; sendState(); });
rngStrength.addEventListener('input', () => { strengthVal.textContent = rngStrength.value; sendState(); });
rngTurb.addEventListener('input', () => { turbVal.textContent = rngTurb.value; sendState(); });
rngWindAngle.addEventListener('input', () => { windAngleVal.textContent = rngWindAngle.value; sendState(); });

btnClear.addEventListener('click', () => worker.postMessage({ type: 'clear' }));
btnPause.addEventListener('click', () => worker.postMessage({ type: 'togglePause' }));

selQuality?.addEventListener('change', () => {
  setQuality(selQuality.value, 'manual');
});

chkQualityAuto?.addEventListener('change', () => {
  // no-op; auto logic reads this value
});

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  return { x, y };
}

function stroke(from, to) {
  worker.postMessage({ type: 'stroke', from, to, state: uiState() });
}

// Use canvas element for pointer events to avoid UI clicks spawning strokes.
// Stop propagation on UI controls so they don't bubble to the canvas.
document.getElementById('ui').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  isDown = true;
  last = canvasPos(e);
  canvas.setPointerCapture(e.pointerId);
  stroke(last, last);
});

canvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  mouse = { ...p, inside: true };
  worker.postMessage({ type: 'cursor', x: p.x, y: p.y });
  if (!isDown) return;
  if (!last) last = p;
  if (lineMode) {
    // In line mode, keep drawing from original start point (don't update last)
    stroke(last, p);
  } else {
    stroke(last, p);
    last = p;
  }
});

canvas.addEventListener('pointerup', (e) => {
  isDown = false;
  last = null;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointerleave', () => { mouse.inside = false; });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') lineMode = true;
  if (e.key.toLowerCase() === 'v') {
    visualizeMode = (visualizeMode + 1) % 4;
    sendState();
  }

  // Quick materials 1..9
  if (e.key >= '1' && e.key <= '9') {
    const idx = Number(e.key) - 1;
    if (MATERIALS[idx]) {
      selMat.value = String(MATERIALS[idx].id);
      sendState();
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') lineMode = false;
});

let lastAutoChangeT = 0;
let lowFpsScore = 0;

function downgradeQuality() {
  if (currentQuality === 'ultra') return setQuality('high', 'auto');
  if (currentQuality === 'high') return setQuality('medium', 'auto');
  if (currentQuality === 'medium') return setQuality('low', 'auto');
}

function onHudStats(msg) {
  if (!chkQualityAuto?.checked) return;
  const fps = Number(msg.fps);
  if (!Number.isFinite(fps)) return;

  // Hysteresis: require several low-FPS samples and a cooldown.
  if (fps < 40) lowFpsScore = Math.min(10, lowFpsScore + 2);
  else if (fps < 45) lowFpsScore = Math.min(10, lowFpsScore + 1);
  else lowFpsScore = Math.max(0, lowFpsScore - 1);

  const now = performance.now();
  if (lowFpsScore >= 6 && now - lastAutoChangeT > 3000) {
    lastAutoChangeT = now;
    lowFpsScore = 0;
    downgradeQuality();
  }
}

sendState();
