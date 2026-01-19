import { E, MATERIALS } from './elements.js';

const canvas = document.getElementById('c');
const ui = document.getElementById('ui');
const hud = document.getElementById('hud');
const hud2 = document.getElementById('hud2');

const selTool = document.getElementById('tool');
const matGroup = document.getElementById('matGroup');
const selMat  = document.getElementById('material');
const rngBrush = document.getElementById('brush');
const brushVal = document.getElementById('brushVal');
const rngStrength = document.getElementById('strength');
const strengthVal = document.getElementById('strengthVal');
const rngTurb = document.getElementById('turb');
const turbVal = document.getElementById('turbVal');
const rngAngle = document.getElementById('angle');
const angleVal = document.getElementById('angleVal');
const rngGlobalWindStrength = document.getElementById('globalWindStrength');
const globalWindStrengthVal = document.getElementById('globalWindStrengthVal');
const rngGlobalWindAngle = document.getElementById('globalWindAngle');
const globalWindAngleVal = document.getElementById('globalWindAngleVal');
const rngWindDamp = document.getElementById('windDamp');
const windDampVal = document.getElementById('windDampVal');
const chkWindFromStroke = document.getElementById('windFromStroke');
const chkWindOverlay = document.getElementById('windOverlay');
const chkWindOverlayColor = document.getElementById('windOverlayColor');
const selQuality = document.getElementById('quality');
const btnClear = document.getElementById('clear');
const btnPause = document.getElementById('pause');

for (const m of MATERIALS) {
  const opt = document.createElement('option');
  opt.value = String(m.id);
  opt.textContent = m.name;
  selMat.appendChild(opt);
}
selMat.value = String(E.SAND);

function updateLabels(){
  brushVal.textContent = rngBrush.value;
  strengthVal.textContent = rngStrength.value;
  turbVal.textContent = rngTurb.value;
  angleVal.textContent = `${rngAngle.value}°`;
  globalWindStrengthVal.textContent = rngGlobalWindStrength.value;
  globalWindAngleVal.textContent = `${rngGlobalWindAngle.value}°`;
  windDampVal.textContent = (Number(rngWindDamp.value) / 100).toFixed(2);
}
updateLabels();

const DPR = Math.min(2, window.devicePixelRatio || 1);

const QUALITY = {
  low:   { w: 480,  h: 270 },
  med:   { w: 640,  h: 360 },
  high:  { w: 960,  h: 540 },
  ultra: { w: 1280, h: 720 },
};

let simW = QUALITY[selQuality.value].w;
let simH = QUALITY[selQuality.value].h;

let worker;
let offscreen;

function buildWorker(first=false){
  if (!first && worker) worker.terminate();
  if (first){
    offscreen = canvas.transferControlToOffscreen();
  }
  worker = new Worker('./simWorker.js', { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'hud') {
      hud.textContent = msg.text;
      hud2.textContent = msg.text2;
    }
  };
  worker.postMessage({ type: 'init', canvas: offscreen, simW, simH, dpr: DPR }, [offscreen]);
  sendState();
}

function rebuildSimSize(){
  const q = QUALITY[selQuality.value];
  simW = q.w; simH = q.h;
  // Rebuild worker and re-transfer canvas: OffscreenCanvas can only be transferred once.
  // So we send a resize message instead.
  worker.postMessage({ type: 'resizeSim', simW, simH, dpr: DPR });
}

let visualizeMode = 0; // 0 none, 1 heatmap, 2 vectors, 3 tracers
let isDown = false;
let last = null;
let lineMode = false;
let lineAnchor = null;
let lineEnd = null;

function uiState(){
  return {
    tool: selTool.value,
    material: Number(selMat.value),
    brush: Number(rngBrush.value),
    strength: Number(rngStrength.value),
    turb: Number(rngTurb.value),
    angleDeg: Number(rngAngle.value),
    globalWindStrength: Number(rngGlobalWindStrength.value),
    globalWindAngle: Number(rngGlobalWindAngle.value),
    windDamp: Number(rngWindDamp.value),
    windFromStroke: chkWindFromStroke.checked,
    windOverlay: chkWindOverlay.checked,
    windOverlayColor: chkWindOverlayColor.checked,
    visualize: visualizeMode,
  };
}

function sendState(){
  if (!worker) return;
  worker.postMessage({ type: 'state', state: uiState() });
}

function canvasPos(e){
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  return { x, y };
}

function stroke(from, to){
  worker.postMessage({ type: 'stroke', from, to, state: uiState() });
}

// Prevent UI clicks from spawning strokes
ui.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  isDown = true;
  last = canvasPos(e);
  lineAnchor = last;
  lineEnd = last;
  
  // Start wind hold tracking for "hold to strengthen" feature
  if (selTool.value === 'wind' || selTool.value === 'vortex') {
    worker.postMessage({ type: 'windHoldStart' });
  }
  
  // immediate stamp feels responsive
  stroke(last, last);
});

canvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  worker.postMessage({ type: 'cursor', x: p.x, y: p.y });
  if (!isDown) return;
  lineEnd = p;
  if (lineMode) return; // commit line on release
  if (!last) last = p;
  stroke(last, p);
  last = p;
});

canvas.addEventListener('pointerup', () => {
  if (lineMode && lineAnchor && lineEnd) {
    stroke(lineAnchor, lineEnd);
  }
  
  // End wind hold tracking
  worker.postMessage({ type: 'windHoldEnd' });
  
  isDown = false;
  last = null;
  lineAnchor = null;
  lineEnd = null;
});
canvas.addEventListener('pointerleave', () => {
  // End wind hold tracking
  worker.postMessage({ type: 'windHoldEnd' });
  
  isDown = false;
  last = null;
  lineAnchor = null;
  lineEnd = null;
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') lineMode = true;
  if (e.key.toLowerCase() === 'v') {
    visualizeMode = (visualizeMode + 1) % 4;
    sendState();
  }
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

// UI handlers
selTool.addEventListener('change', () => {
  // Material selector only relevant for paint tool
  matGroup.style.opacity = (selTool.value === 'paint') ? '1' : '0.5';
  sendState();
});
selMat.addEventListener('change', sendState);

rngBrush.addEventListener('input', () => { updateLabels(); sendState(); });
rngStrength.addEventListener('input', () => { updateLabels(); sendState(); });
rngTurb.addEventListener('input', () => { updateLabels(); sendState(); });
rngAngle.addEventListener('input', () => { updateLabels(); sendState(); });
rngGlobalWindStrength.addEventListener('input', () => { updateLabels(); sendState(); });
rngGlobalWindAngle.addEventListener('input', () => { updateLabels(); sendState(); });
rngWindDamp.addEventListener('input', () => { updateLabels(); sendState(); });
chkWindFromStroke.addEventListener('change', sendState);
chkWindOverlay.addEventListener('change', sendState);
chkWindOverlayColor.addEventListener('change', sendState);

selQuality.addEventListener('change', () => {
  rebuildSimSize();
});

btnClear.addEventListener('click', () => worker.postMessage({ type: 'clear' }));
btnPause.addEventListener('click', () => worker.postMessage({ type: 'togglePause' }));

// Boot
buildWorker(true);
