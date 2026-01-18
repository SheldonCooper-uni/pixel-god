// main.js
import { E, MATERIALS } from './elements.js';

const canvas = document.getElementById('c');
const ui = document.getElementById('ui');
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

const DPR = Math.min(2, window.devicePixelRatio || 1);

// Choose a simulation resolution that scales well.
// You can push this higher; performance depends on CPU.
const SIM_W = 640;
const SIM_H = 360;

// Offscreen canvas -> worker handles simulation + rendering (keeps UI smooth)
const off = canvas.transferControlToOffscreen();
const worker = new Worker('./simWorker.js', { type: 'module' });

worker.postMessage({
  type: 'init',
  canvas: off,
  simW: SIM_W,
  simH: SIM_H,
  dpr: DPR,
}, [off]);

function resizeDisplay() {
  const scale = Math.max(
    1,
    Math.floor(Math.min(window.innerWidth / SIM_W, window.innerHeight / SIM_H)),
  );
  canvas.style.width = `${SIM_W * scale}px`;
  canvas.style.height = `${SIM_H * scale}px`;
}

resizeDisplay();
window.addEventListener('resize', resizeDisplay);

let visualizeMode = 0; // 0 none, 1 wind speed, 2 vectors, 3 tracers
let isDown = false;
let last = null;
let lineMode = false;
let mouse = { x: 0, y: 0, inside: false };

function uiState() {
  return {
    tool: selTool.value,
    material: Number(selMat.value),
    brush: Number(rngBrush.value),
    strength: Number(rngStrength.value),
    turb: Number(rngTurb.value),
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

btnClear.addEventListener('click', () => worker.postMessage({ type: 'clear' }));
btnPause.addEventListener('click', () => worker.postMessage({ type: 'togglePause' }));

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  return { x, y };
}

function stroke(from, to) {
  worker.postMessage({ type: 'stroke', from, to, state: uiState() });
}

function isUiEvent(e) {
  return Boolean(e.target.closest('#ui'));
}

function stopUiPointer(e) {
  e.preventDefault();
  e.stopPropagation();
}

ui.addEventListener('pointerdown', stopUiPointer);
ui.addEventListener('pointermove', stopUiPointer);
ui.addEventListener('pointerup', stopUiPointer);

window.addEventListener('pointerdown', (e) => {
  if (isUiEvent(e)) return;
  if (e.button !== 0) return;
  isDown = true;
  last = canvasPos(e);
  stroke(last, last);
});

window.addEventListener('pointermove', (e) => {
  if (isUiEvent(e)) return;
  const p = canvasPos(e);
  mouse = { ...p, inside: true };
  worker.postMessage({ type: 'cursor', x: p.x, y: p.y });
  if (!isDown) return;
  if (!last) last = p;
  if (lineMode) {
    // draw a preview line using worker side? we'll just send stroke; worker will draw line.
    stroke(last, p);
    last = p;
  } else {
    stroke(last, p);
    last = p;
  }
});

window.addEventListener('pointerup', () => { isDown = false; last = null; });
window.addEventListener('pointerleave', () => { mouse.inside = false; });

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

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'hud') {
    hud.textContent = msg.text;
    hud2.textContent = msg.text2;
  }
};

sendState();
