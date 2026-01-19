// simWorker.js — core simulation in a Web Worker (OffscreenCanvas)
import {
  E, PALETTE, DENSITY,
  IS_SOLID, IS_POWDER, IS_FLUID, IS_GAS, IS_BURNABLE, IS_ORGANIC, IS_CONDUCTIVE,
  NAME_BY_ID, WIND_COUPLING,
  isEmptyCell,
} from './elements.js';

let canvas, ctx;
let W = 640, H = 360, DPR = 1;

// World buffers
let typeA, dataA; // Uint8

// Chunking (performance)
const CHUNK = 32;
let cW = 0, cH = 0;
let cActive, cDirty, cChanged, cSleep;

// Air grid (coarse)
const AIR_SCALE = 4;
let aW = 0, aH = 0;
let pField, pNext, vxField, vyField, vxNext, vyNext; // Int16
let solidField; // Uint8: 0..4 samples of solidity

// Ambient wind (keeps the world subtly alive even when you do nothing)
let ambVX = 0, ambVY = 0;
let ambVXTarget = 0, ambVYTarget = 0;

// Global wind (UI controlled)
let globalVX = 0;
let globalVY = 0;

// Realistic wind thresholds for sand/powder physics
// Below LOW: no movement (avoids telekinesis feel)
// LOW..MED: diagonal bias when falling
// MED..HIGH: saltation (small hops)
// Above HIGH: strong saltation + dune migration
const WIND_THRESHOLD_LOW = 2500;    // minimum wind to affect sand
const WIND_THRESHOLD_MED = 6000;    // diagonal sliding
const WIND_THRESHOLD_HIGH = 12000;  // saltation begins
const WIND_THRESHOLD_STORM = 20000; // strong saltation + longer jumps

// Render buffers
let img, pix32;

// Entities
const entities = [];
let nextEntityId = 1;

// Fast RNG
let seed = 123456789;
function rnd(){ seed = (seed * 1664525 + 1013904223) | 0; return (seed >>> 0) / 4294967296; }
function irand(n){ return (rnd()*n) | 0; }

function idx(x,y){ return x + y*W; }
function inb(x,y){ return x>=0 && x<W && y>=0 && y<H; }

function clamp(v,lo,hi){ return v<lo?lo:(v>hi?hi:v); }

function cidx(cx,cy){ return cx + cy*cW; }
function cellToChunkX(x){ return (x / CHUNK) | 0; }
function cellToChunkY(y){ return (y / CHUNK) | 0; }

function aidx(ax,ay){ return ax + ay*aW; }
function toAirX(x){ return (x / AIR_SCALE) | 0; }
function toAirY(y){ return (y / AIR_SCALE) | 0; }

// Input queue (throttle painting)
const paintQueue = [];
let maxStrokesPerTick = 3;
const MAX_QUEUE = 300;

let paused = false;
let tick = 0;

// UI state from main thread
let state = {
  tool: 'paint',
  material: E.SAND,
  brush: 14,
  strength: 35,
  turb: 18,
  angleDeg: 0,
  globalWindStrength: 0,
  globalWindAngle: 0,
  windFromStroke: true,
  windDamp: 93,
  windOverlay: false,
  windOverlayColor: false,
  visualize: 0,
};
let lastWindDir = { x: 1, y: 0 };

// Wind "hold to strengthen" state
let windHoldStartTime = 0;
let windHoldActive = false;
const WIND_MAX_STRENGTH = 9.0;     // Maximum multiplier from holding
const WIND_BASE_STRENGTH = 1.0;   // Base multiplier
const WIND_RAMP_PER_SEC = 0.6;    // How fast strength builds per second

// Cursor sampling
let cursorCell = { x: 0, y: 0 };
let lastHudSend = 0;

// --- Sprites (tiny pixel art, rendered in worker) ---
// Each sprite is an array of rows, using chars:
// '.' empty, 'S' skin, 'C' cloth, 'B' black, 'W' white
const SPRITES = {
  human: {
    w: 7, h: 10,
    rows: [
      '..BBB..',
      '.BWWWB.',
      '.BWSWB.',
      '.BWWWB.',
      '..CCC..',
      '..CCC..',
      '.CCCCC.',
      '..C.C..',
      '..C.C..',
      '.C...C.',
    ],
  },
  bird: {
    w: 7, h: 5,
    rows: [
      '...W...',
      '..WWW..',
      '.WBBBW.',
      '..WWW..',
      '...W...',
    ],
  },
};

const SPRITE_COLORS = {
  S: 'rgba(240,210,180,1)',
  C: 'rgba(110,170,255,1)',
  B: 'rgba(25,25,30,1)',
  W: 'rgba(240,240,248,1)',
};

function resizeCanvas(){
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.imageSmoothingEnabled = false;
}

function initBuffers(){
  typeA = new Uint8Array(W*H);
  dataA = new Uint8Array(W*H);

  cW = Math.ceil(W / CHUNK);
  cH = Math.ceil(H / CHUNK);
  const cn = cW*cH;
  cActive = new Uint8Array(cn);
  cDirty = new Uint8Array(cn);
  cChanged = new Uint8Array(cn);
  cSleep = new Uint16Array(cn);

  aW = Math.ceil(W / AIR_SCALE);
  aH = Math.ceil(H / AIR_SCALE);
  const an = aW*aH;
  pField = new Int16Array(an);
  pNext  = new Int16Array(an);
  vxField = new Int16Array(an);
  vyField = new Int16Array(an);
  vxNext = new Int16Array(an);
  vyNext = new Int16Array(an);
  solidField = new Uint8Array(an);

  img = ctx.createImageData(W, H);
  pix32 = new Uint32Array(img.data.buffer);

  clearWorld(true);

  // Seed scene: some ground + tiny lake
  for (let y = H-50; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x,y);
      typeA[i] = (y > H-10) ? E.STONE : E.DIRT;
      dataA[i] = (y > H-25) ? 110 : 60; // moisture
      markCellDirty(x,y);
    }
  }
  for (let y = H-40; y < H-25; y++) {
    for (let x = 40; x < 140; x++) {
      const i = idx(x,y);
      typeA[i] = E.WATER;
      dataA[i] = 128;
      markCellDirty(x,y);
    }
  }
}

function clearWorld(full){
  typeA.fill(E.AIR);
  dataA.fill(0);
  pField.fill(0);
  pNext.fill(0);
  vxField.fill(0);
  vyField.fill(0);
  if (vxNext) vxNext.fill(0);
  if (vyNext) vyNext.fill(0);
  entities.length = 0;
  nextEntityId = 1;
  cActive.fill(0);
  cDirty.fill(1);
  cChanged.fill(1);
  cSleep.fill(0);
  ambVX = 0; ambVY = 0;
  ambVXTarget = 0; ambVYTarget = 0;
  if (full) {
    // mark all chunks active for one render pass
    for (let i = 0; i < cActive.length; i++) cActive[i] = 1;
  }
}

function markChunk(cx,cy){
  if (cx < 0 || cy < 0 || cx >= cW || cy >= cH) return;
  const ci = cidx(cx,cy);
  cActive[ci] = 1;
  cDirty[ci] = 1;
  cChanged[ci] = 1;
  cSleep[ci] = 0;
}

function markCellDirty(x,y){
  const cx = cellToChunkX(x);
  const cy = cellToChunkY(y);
  markChunk(cx,cy);
}

function markCellAndNeighbors(x,y){
  const cx = cellToChunkX(x);
  const cy = cellToChunkY(y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      markChunk(cx+dx, cy+dy);
    }
  }
}

function swapAt(x1,y1,x2,y2){
  const i = idx(x1,y1);
  const j = idx(x2,y2);
  const t = typeA[i]; typeA[i] = typeA[j]; typeA[j] = t;
  const d = dataA[i]; dataA[i] = dataA[j]; dataA[j] = d;
  markCellAndNeighbors(x1,y1);
  markCellAndNeighbors(x2,y2);
}

function setCell(x,y,t,d=0){
  const i = idx(x,y);
  typeA[i] = t;
  dataA[i] = d;
  markCellAndNeighbors(x,y);
}

function updateAmbientWind(){
  // Very small drifting wind so the world never feels "dead".
  // Targets change slowly; actual value eases towards target.
  if ((tick & 255) === 0) {
    ambVXTarget = (irand(1601) - 800); // [-800..800]
    ambVYTarget = (irand(801) - 400);  // [-400..400]
  }
  ambVX += (ambVXTarget - ambVX) * 0.02;
  ambVY += (ambVYTarget - ambVY) * 0.02;
}

function sampleAirVX(x,y){
  const ai = aidx(toAirX(x), toAirY(y));
  return (vxField[ai] + (ambVX|0) + (globalVX|0)) | 0;
}
function sampleAirVY(x,y){
  const ai = aidx(toAirX(x), toAirY(y));
  return (vyField[ai] + (ambVY|0) + (globalVY|0)) | 0;
}
function sampleAirP(x,y){ return pField[aidx(toAirX(x), toAirY(y))] | 0; }

function updateSolidField(){
  // Coarse solidity per air cell (0..4) by sampling 4 points.
  for (let ay=0; ay<aH; ay++) {
    const baseY = ay * AIR_SCALE;
    for (let ax=0; ax<aW; ax++) {
      const baseX = ax * AIR_SCALE;
      let s = 0;
      const x1 = clamp(baseX + 1, 0, W-1);
      const x2 = clamp(baseX + AIR_SCALE - 2, 0, W-1);
      const y1 = clamp(baseY + 1, 0, H-1);
      const y2 = clamp(baseY + AIR_SCALE - 2, 0, H-1);
      if (IS_SOLID[typeA[idx(x1,y1)]]) s++;
      if (IS_SOLID[typeA[idx(x2,y1)]]) s++;
      if (IS_SOLID[typeA[idx(x1,y2)]]) s++;
      if (IS_SOLID[typeA[idx(x2,y2)]]) s++;
      solidField[aidx(ax,ay)] = s;
    }
  }
}

// --- Tools (paint/wind/pressure/temp/spawn) ---
function applyBrushCircle(cx, cy, r, fn){
  const rr = r*r;
  const x0 = Math.max(0, cx-r), x1 = Math.min(W-1, cx+r);
  const y0 = Math.max(0, cy-r), y1 = Math.min(H-1, cy+r);
  for (let y=y0; y<=y1; y++) {
    const dy = y-cy;
    for (let x=x0; x<=x1; x++) {
      const dx = x-cx;
      if (dx*dx + dy*dy <= rr) fn(x,y);
    }
  }
}

function applyBrushCircleFalloff(cx, cy, r, fn){
  // Like applyBrushCircle, but passes a smooth 0..1 falloff.
  const rr = r*r;
  const x0 = Math.max(0, cx-r), x1 = Math.min(W-1, cx+r);
  const y0 = Math.max(0, cy-r), y1 = Math.min(H-1, cy+r);
  for (let y=y0; y<=y1; y++) {
    const dy = y-cy;
    for (let x=x0; x<=x1; x++) {
      const dx = x-cx;
      const d2 = dx*dx + dy*dy;
      if (d2 <= rr) {
        const fall = 1 - (d2 / rr);
        fn(x,y,fall);
      }
    }
  }
}

function applyBrushCircleGaussian(cx, cy, r, fn){
  // Gaussian falloff for a softer, more natural jet core.
  const rr = r*r;
  const sigma = Math.max(1, r * 0.45);
  const twoSigma2 = 2 * sigma * sigma;
  const x0 = Math.max(0, cx-r), x1 = Math.min(W-1, cx+r);
  const y0 = Math.max(0, cy-r), y1 = Math.min(H-1, cy+r);
  for (let y=y0; y<=y1; y++) {
    const dy = y-cy;
    for (let x=x0; x<=x1; x++) {
      const dx = x-cx;
      const d2 = dx*dx + dy*dy;
      if (d2 <= rr) {
        const fall = Math.exp(-d2 / twoSigma2);
        fn(x,y,fall,d2);
      }
    }
  }
}

function drawLine(x0,y0,x1,y1, plot){
  x0|=0; y0|=0; x1|=0; y1|=0;
  let dx = Math.abs(x1-x0), sx = x0<x1 ? 1 : -1;
  let dy = -Math.abs(y1-y0), sy = y0<y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    plot(x0,y0);
    if (x0===x1 && y0===y1) break;
    const e2 = 2*err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function paintAt(nx, ny, nx2, ny2, st){
  const x0 = clamp((nx*W)|0, 0, W-1);
  const y0 = clamp((ny*H)|0, 0, H-1);
  const x1 = clamp((nx2*W)|0, 0, W-1);
  const y1 = clamp((ny2*H)|0, 0, H-1);

  // direction info for wind tool
  const ddx = x1-x0;
  const ddy = y1-y0;
  const len = Math.hypot(ddx,ddy);
  let dirx = lastWindDir.x, diry = lastWindDir.y;
  if (len > 0.001) {
    dirx = ddx/len;
    diry = ddy/len;
    lastWindDir = { x: dirx, y: diry };
  }

  const tool = st.tool;
  const r = st.brush|0;

  // fixed-angle direction (deg)
  const ang = ((st.angleDeg||0) * Math.PI) / 180;
  const fixedDir = { x: Math.cos(ang), y: Math.sin(ang) };

  const stamp = (x,y,fall=1, cx=x, cy=y) => {
    if (!inb(x,y)) return;
    const i = idx(x,y);

    if (tool === 'erase') {
      typeA[i] = E.AIR; dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }

    if (tool === 'paint') {
      const t = st.material|0;
      typeA[i] = t;
      // init per element
      if (t===E.FIRE) dataA[i] = 60 + irand(70);
      else if (t===E.SMOKE) dataA[i] = 120 + irand(100);
      else if (t===E.STEAM) dataA[i] = 80 + irand(60);
      else if (t===E.WATER) dataA[i] = 128;
      else if (t===E.DIRT) dataA[i] = 80;
      else if (t===E.MUD) dataA[i] = 140;
      else if (t===E.SEED) dataA[i] = 0;
      else if (t===E.SPROUT) dataA[i] = 0;
      else if (t===E.PLANT) dataA[i] = 20;
      else if (t===E.ACID) dataA[i] = 200; // strength
      else if (t===E.SOAP) dataA[i] = 150;
      else if (t===E.GAS) dataA[i] = 180 + irand(60); // TTL
      else if (t===E.NITRO) dataA[i] = 0; // stability counter
      else if (t===E.FIREWORK) dataA[i] = 80 + irand(100); // fuse timer
      else if (t===E.VINE) dataA[i] = 0; // age
      else if (t===E.ANT) dataA[i] = irand(4); // direction
      else if (t===E.METAL) dataA[i] = 0; // rust level
      else dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }

    // Laser tool - shoots a beam that cuts/heats
    if (tool === 'laser') {
      shootLaser(x, y, fixedDir);
      return;
    }

    // Clone tool - copies cells from source
    if (tool === 'clone') {
      // clone is handled separately via cloneSource tracking
      return;
    }

    // entity spawns
    if (tool === 'spawnHuman') {
      spawnEntity('human', x, y);
      return;
    }
    if (tool === 'spawnBird') {
      spawnEntity('bird', x, y);
      return;
    }

    // wind/pressure/temp tools affect air or nearby materials
    const ax = toAirX(x), ay = toAirY(y);
    const ai = aidx(ax,ay);

    if (tool === 'wind') {
      const baseStrength = st.strength|0;
      const turb = st.turb|0;
      const useStroke = !!st.windFromStroke;
      const d = useStroke ? { x: dirx, y: diry } : fixedDir;

      // ===== HOLD-TO-STRENGTHEN =====
      // WindStrength = min(MaxStrength, Base + HoldTime * Ramp)
      // MaxStrength = 9, Ramp = 0.6 per second
      const holdTime = windHoldActive ? (performance.now() - windHoldStartTime) / 1000 : 0;
      const holdMultiplier = Math.min(WIND_MAX_STRENGTH, WIND_BASE_STRENGTH + holdTime * WIND_RAMP_PER_SEC);

      // ===== JET BRUSH (nicht Laser!) =====
      // Mitte: stark, Rand: abfallend (weich), leichtes Fächern
      const edge = 1 - fall;
      const distFromCenter = Math.sqrt(1 - fall); // 0 = center, 1 = edge

      // Perpendicular vector for fan-out
      const perpX = -d.y;
      const perpY = d.x;

      // Fan-out: Breitet sich am Rand aus (damit's nicht wie Laser wirkt)
      // Stärker fächern bei höherer Turbulenz
      const fanBase = 0.18 + (turb / 120);
      const fanStrength = fanBase * distFromCenter * distFromCenter;

      // Alternierende Fan-Richtung basierend auf Position für Volumen-Effekt
      const fanPhase = Math.sin((ax * 0.7 + ay * 0.5 + tick * 0.1));

      // Start with base direction
      let nx = d.x;
      let ny = d.y;

      // Add perpendicular fan-out at edges (cone shape)
      nx += perpX * fanStrength * fanPhase;
      ny += perpY * fanStrength * fanPhase;

      // Turbulenz: zufällige Winkelabweichung (mehr am Rand)
      if (turb > 0) {
        const turbScale = (turb / 100) * (0.25 + edge * 0.75);
        const turbAngle = ((irand(2001) - 1000) / 1000) * turbScale * 0.6;
        const ca = Math.cos(turbAngle), sa = Math.sin(turbAngle);
        const rx = nx*ca - ny*sa;
        const ry = nx*sa + ny*ca;
        nx = rx; ny = ry;
      }

      // Normalize direction
      const mag = Math.hypot(nx,ny) || 1;
      nx /= mag; ny /= mag;

      // ===== STRENGTH PROFILE =====
      // Gaussian-like: Core=100%, edge=20% (soft falloff)
      const coreStrength = baseStrength * 12 * holdMultiplier;
      const profiledStrength = coreStrength * (0.20 + 0.80 * fall);

      // Apply velocity to air field
      vxField[ai] = clamp(vxField[ai] + (nx * profiledStrength)|0, -30000, 30000);
      vyField[ai] = clamp(vyField[ai] + (ny * profiledStrength)|0, -30000, 30000);

      // ===== PRESSURE PUSH =====
      // Erzeugt Druck in Windrichtung - hilft bei Ausbreitung
      if (fall > 0.05) {
        const pressureNudge = baseStrength * 10 * fall * holdMultiplier;
        pField[ai] = clamp(pField[ai] + pressureNudge|0, -30000, 30000);
      }

      // ===== SPREAD TO NEIGHBORS (breite Jet-Ausbreitung) =====
      // Wind ist kein Laser - breitet sich zu benachbarten Zellen aus
      const spreadRadius = fall > 0.5 ? 2 : 1;
      const baseSpread = profiledStrength * 0.22;

      for (let sdy = -spreadRadius; sdy <= spreadRadius; sdy++) {
        for (let sdx = -spreadRadius; sdx <= spreadRadius; sdx++) {
          if (sdx === 0 && sdy === 0) continue;
          const sax = ax + sdx;
          const say = ay + sdy;
          if (sax < 0 || sax >= aW || say < 0 || say >= aH) continue;

          const sai = aidx(sax, say);
          const dist = Math.hypot(sdx, sdy);
          const spreadFall = 1 / (1 + dist * 0.6);
          const spreadStr = baseSpread * spreadFall;

          // Fächert auch beim Spreaden aus
          const spreadNX = nx + perpX * sdx * 0.08;
          const spreadNY = ny + perpY * sdy * 0.08;

          vxField[sai] = clamp(vxField[sai] + (spreadNX * spreadStr)|0, -30000, 30000);
          vyField[sai] = clamp(vyField[sai] + (spreadNY * spreadStr)|0, -30000, 30000);
        }
      }

      // keep chunk active for visible effect
      markCellAndNeighbors(x,y);
      return;
    }

    if (tool === 'pressure' || tool === 'pressureSource' || tool === 'pressureSink') {
      const raw = st.strength|0;
      const s = Math.abs(raw);
      const dir = (tool === 'pressureSink') ? -1 : (tool === 'pressureSource' ? 1 : (raw>=0?1:-1));
      pField[ai] = clamp(pField[ai] + (dir*s*45*fall)|0, -30000, 30000);
      markCellAndNeighbors(x,y);
      return;
    }

    // Vortex tool - creates circular/spinning wind
    if (tool === 'vortex') {
      const s = (st.strength|0);
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx,dy) || 1;
      
      // Hold-to-strengthen for vortex too
      const holdTime = windHoldActive ? (performance.now() - windHoldStartTime) / 1000 : 0;
      const holdMultiplier = Math.min(WIND_MAX_STRENGTH, WIND_BASE_STRENGTH + holdTime * WIND_RAMP_PER_SEC);
      
      // Tangential direction (perpendicular to radius)
      let tx = -dy / dist;
      let ty = dx / dist;
      
      // Direction based on sign of strength (clockwise vs counter-clockwise)
      const sign = s >= 0 ? 1 : -1;
      tx *= sign;
      ty *= sign;
      
      const sf = Math.abs(s) * 10 * (0.25 + 0.75*fall) * holdMultiplier;
      vxField[ai] = clamp(vxField[ai] + (tx*sf)|0, -30000, 30000);
      vyField[ai] = clamp(vyField[ai] + (ty*sf)|0, -30000, 30000);
      
      // Inward/outward pressure to keep swirl coherent
      pField[ai] = clamp(pField[ai] + (sign * -15 * fall * holdMultiplier)|0, -30000, 30000);
      markCellAndNeighbors(x,y);
      return;
    }

    if (tool === 'temp') {
      const s = st.strength|0;
      // hot: ignite / melt / steam
      if (s > 0) {
        if (IS_BURNABLE[typeA[i]] && rnd()<0.65) { typeA[i]=E.FIRE; dataA[i]=70+irand(80); }
        if (typeA[i]===E.ICE) { typeA[i]=E.WATER; dataA[i]=0; }
        if (typeA[i]===E.WATER && rnd()<0.12) { typeA[i]=E.STEAM; dataA[i]=60+irand(60); }
        // heat increases pressure
        pField[ai] = clamp(pField[ai] + 220, -30000, 30000);
      } else if (s < 0) {
        if (typeA[i]===E.WATER && rnd()<0.65) { typeA[i]=E.ICE; dataA[i]=0; }
        if (typeA[i]===E.LAVA && rnd()<0.35) { typeA[i]=E.STONE; dataA[i]=0; }
        pField[ai] = clamp(pField[ai] - 180, -30000, 30000);
      }
      markCellAndNeighbors(x,y);
      return;
    }
  };

  drawLine(x0,y0,x1,y1,(x,y)=>{
    if (tool === 'wind' || tool === 'vortex') {
      applyBrushCircleGaussian(x,y,r,(xx,yy,fall)=>stamp(xx,yy,fall,x,y));
    } else if (tool === 'pressure' || tool === 'pressureSource' || tool === 'pressureSink' || tool === 'temp') {
      applyBrushCircleFalloff(x,y,r,(xx,yy,fall)=>stamp(xx,yy,fall,x,y));
    } else {
      applyBrushCircle(x,y,r,(xx,yy)=>stamp(xx,yy,1,x,y));
    }
  });
}

function spawnEntity(kind, x, y){
  if (entities.length > 250) return;
  const sp = SPRITES[kind];
  const e = {
    id: nextEntityId++,
    kind,
    x: clamp(x|0, 0, W-1),
    y: clamp(y|0, 0, H-1),
    vx: 0,
    vy: 0,
    dir: rnd()<0.5 ? -1 : 1,
    mood: 0,
    t: 0,
    w: sp.w,
    h: sp.h,
    lastX: x|0,
    lastY: y|0,
  };
  entities.push(e);
  markEntityDirty(e, true);
}

function markEntityDirty(e, includeOld){
  const sp = SPRITES[e.kind];
  if (includeOld) {
    for (let dy=0; dy<sp.h; dy++) for (let dx=0; dx<sp.w; dx++) {
      const x = e.lastX + dx - (sp.w>>1);
      const y = e.lastY + dy - (sp.h>>1);
      if (inb(x,y)) markCellDirty(x,y);
    }
  }
  for (let dy=0; dy<sp.h; dy++) for (let dx=0; dx<sp.w; dx++) {
    const x = (e.x|0) + dx - (sp.w>>1);
    const y = (e.y|0) + dy - (sp.h>>1);
    if (inb(x,y)) markCellDirty(x,y);
  }
}

// --- Simulation rules ---

function trySwapIfHeavier(x,y,nx,ny){
  if (!inb(nx,ny)) return false;
  const a = typeA[idx(x,y)];
  const b = typeA[idx(nx,ny)];
  if (b === E.AIR || b === E.SMOKE || b === E.STEAM) {
    swapAt(x,y,nx,ny);
    return true;
  }
  if (IS_SOLID[b]) return false;
  if (DENSITY[b] < DENSITY[a]) {
    swapAt(x,y,nx,ny);
    return true;
  }
  return false;
}

// Helper to get effective wind force on a particle based on its coupling factor
function getEffectiveWind(x, y, elementType) {
  const coupling = WIND_COUPLING[elementType] || 0;
  if (coupling === 0) return { vx: 0, vy: 0, mag: 0 };
  
  const rawVX = sampleAirVX(x, y);
  const rawVY = sampleAirVY(x, y);
  const vx = rawVX * coupling;
  const vy = rawVY * coupling;
  const mag = Math.abs(vx) + Math.abs(vy);
  
  return { vx, vy, mag, rawMag: Math.abs(rawVX) + Math.abs(rawVY) };
}

function powderStep(x,y,t){
  // Get wind at this position with coupling factor
  const wind = getEffectiveWind(x, y, t);
  const vx = wind.vx;
  const vy = wind.vy;
  const wmag = wind.mag;
  const rawWmag = wind.rawMag;
  const i = idx(x,y);
  const windDir = vx < 0 ? -1 : (vx > 0 ? 1 : 0);

  // ===== WET SAND SYSTEM =====
  // Sand nimmt Feuchtigkeit auf (wetness), bleibt aber Sand
  // Erst bei hoher wetness UND längerem Wasserkontakt -> Mud
  // dataA für Sand: wetness (0-255)
  if (t===E.SAND) {
    let wetness = dataA[i] | 0;
    const hasWater = hasNeighborOfType(x,y,E.WATER);

    if (hasWater) {
      // Sand absorbiert Wasser langsam
      wetness = Math.min(255, wetness + 3);
      dataA[i] = wetness;

      // Nur wenn SEHR nass UND lange im Wasser -> Mud
      // threshold = 200, chance nur 0.8% pro Tick
      if (wetness > 200 && rnd() < 0.008) {
        setCell(x,y,E.MUD, 150);
        return;
      }
    } else {
      // Sand trocknet langsam aus (ohne Wasser)
      if (wetness > 0 && (tick & 7) === 0) {
        wetness = Math.max(0, wetness - 1);
        dataA[i] = wetness;
      }
    }

    // Nasser Sand: schwerer, rutscht anders
    // wetness > 100 = schwerer (weniger Saltation)
    // Dies wird in den Bewegungs-Checks weiter unten berücksichtigt
  }

  // NITRO - extrem instabil!
  if (t===E.NITRO) {
    const ai = aidx(toAirX(x), toAirY(y));
    const p = Math.abs(pField[ai]);
    const unstable = dataA[i];
    
    if (p > 5000 || rawWmag > 8000) {
      dataA[i] = Math.min(255, unstable + 5);
    }
    
    const shouldExplode = (
      hasNeighborOfType(x,y,E.FIRE) ||
      hasNeighborOfType(x,y,E.SPARK) ||
      hasNeighborOfType(x,y,E.LAVA) ||
      p > 15000 ||
      unstable > 200
    );
    
    if (shouldExplode) {
      explodeAt(x, y, 8, 4500);
      return;
    }
  }

  // FIREWORK - timer fuse, then explodes colorfully
  if (t===E.FIREWORK) {
    let fuse = dataA[i];
    if (fuse > 0) {
      dataA[i] = fuse - 1;
      if (rnd() < 0.1) {
        const sx = clamp(x + irand(3)-1, 0, W-1);
        const sy = clamp(y - 1, 0, H-1);
        const si = idx(sx,sy);
        if (typeA[si]===E.AIR) {
          typeA[si]=E.SPARK; dataA[si]=8+irand(8);
          markCellAndNeighbors(sx,sy);
        }
      }
    } else {
      fireworkExplode(x, y);
      return;
    }
    
    if (hasNeighborOfType(x,y,E.FIRE) || hasNeighborOfType(x,y,E.SPARK)) {
      dataA[i] = Math.max(0, dataA[i] - 10);
    }
  }

  // ANT - mini entity behavior as powder
  if (t===E.ANT) {
    antStep(x, y);
    return;
  }

  // RUST - crumbles away slowly
  if (t===E.RUST) {
    if (rnd() < 0.005) {
      typeA[i] = E.ASH;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }
  }

  const belowY = y+1;
  
  // ============================================
  // REALISTIC WIND PHYSICS FOR SAND & POWDERS
  // ============================================
  
  // Check if particle is exposed to wind (has air above or to the side)
  const exposedToWind = (y > 0 && isEmptyCell(typeA[idx(x, y-1)])) ||
                        (x > 0 && isEmptyCell(typeA[idx(x-1, y)])) ||
                        (x < W-1 && isEmptyCell(typeA[idx(x+1, y)]));
  
  // ==== SAND & DIRT: Realistic saltation physics ====
  if (t===E.SAND || t===E.DIRT) {
    // Below threshold: no wind effect (avoids telekinesis feel)
    // Gravity still works normally
    if (wmag < WIND_THRESHOLD_LOW || !exposedToWind) {
      // Pure gravity - random diagonal bias
      const bias = rnd() < 0.5 ? -1 : 1;
      if (belowY < H && trySwapIfHeavier(x,y,x,belowY)) return;
      if (belowY < H && trySwapIfHeavier(x,y,x+bias,belowY)) return;
      if (belowY < H) trySwapIfHeavier(x,y,x-bias,belowY);
      return;
    }
    
    // Medium wind: diagonal bias when falling (sand slides in wind direction)
    if (wmag < WIND_THRESHOLD_HIGH) {
      // Fall straight down first
      if (belowY < H && trySwapIfHeavier(x,y,x,belowY)) return;
      
      // Then try wind-biased diagonal (70% wind dir, 30% random)
      const biasedDir = rnd() < 0.70 ? windDir : -windDir;
      if (belowY < H && trySwapIfHeavier(x,y,x+biasedDir,belowY)) return;
      if (belowY < H) trySwapIfHeavier(x,y,x-biasedDir,belowY);
      return;
    }
    
    // High wind: SALTATION - grains hop!
    // Probability increases with wind strength
    const saltationChance = wmag < WIND_THRESHOLD_STORM ? 0.18 : 0.35;
    const isOnSurface = belowY >= H || !isEmptyCell(typeA[idx(x, belowY)]);
    
    if (isOnSurface && rnd() < saltationChance) {
      // Saltation hop! Grain jumps up and forward
      // Storm wind = longer jumps
      const hopHeight = wmag > WIND_THRESHOLD_STORM ? (1 + irand(2)) : 1;
      const hopForward = wmag > WIND_THRESHOLD_STORM ? (1 + irand(2)) : 1;
      
      // Try different hop trajectories
      for (let h = hopHeight; h >= 1; h--) {
        for (let f = hopForward; f >= 1; f--) {
          const tx = x + windDir * f;
          const ty = y - h;
          if (inb(tx, ty) && isEmptyCell(typeA[idx(tx, ty)])) {
            swapAt(x, y, tx, ty);
            // Add small air push in hop direction for visual effect
            const ai = aidx(toAirX(tx), toAirY(ty));
            vxField[ai] = clamp(vxField[ai] + windDir * 200, -30000, 30000);
            return;
          }
        }
      }
      
      // If hop blocked, try forward slide on surface
      const slideX = x + windDir;
      if (inb(slideX, y) && isEmptyCell(typeA[idx(slideX, y)])) {
        swapAt(x, y, slideX, y);
        return;
      }
    }
    
    // Airborne grain? Let wind push it sideways
    if (!isOnSurface && rnd() < 0.5) {
      const pushX = x + windDir;
      if (inb(pushX, y) && isEmptyCell(typeA[idx(pushX, y)])) {
        swapAt(x, y, pushX, y);
        return;
      }
    }
    
    // Normal falling with strong wind bias
    if (belowY < H && trySwapIfHeavier(x,y,x,belowY)) return;
    if (belowY < H && trySwapIfHeavier(x,y,x+windDir,belowY)) return;
    if (belowY < H) trySwapIfHeavier(x,y,x-windDir,belowY);
    return;
  }
  
  // ==== GRAVEL: Heavy, needs very strong wind ====
  if (t===E.GRAVEL) {
    if (belowY < H && trySwapIfHeavier(x,y,x,belowY)) return;
    
    // Only moves in storm-level winds
    if (wmag > WIND_THRESHOLD_STORM && exposedToWind && rnd() < 0.12) {
      // Short hop or slide
      const tx = x + windDir;
      if (inb(tx, y-1) && isEmptyCell(typeA[idx(tx, y-1)])) {
        swapAt(x, y, tx, y-1);
        return;
      }
      if (inb(tx, y) && isEmptyCell(typeA[idx(tx, y)])) {
        swapAt(x, y, tx, y);
        return;
      }
    }
    
    // Normal diagonal falling
    const bias = wmag > WIND_THRESHOLD_MED ? windDir : (rnd() < 0.5 ? -1 : 1);
    if (belowY < H && trySwapIfHeavier(x,y,x+bias,belowY)) return;
    if (belowY < H) trySwapIfHeavier(x,y,x-bias,belowY);
    return;
  }
  
  // ==== ASH & SEED: Light particles, very wind-sensitive ====
  if (t===E.ASH || t===E.SEED) {
    // These are light - wind affects them even at low levels
    if (wmag > WIND_THRESHOLD_LOW && exposedToWind) {
      // Can be lifted by upward wind
      if (vy < -2000 && rnd() < 0.40) {
        const tx = x + windDir;
        const ty = y - 1;
        if (inb(tx, ty) && isEmptyCell(typeA[idx(tx, ty)])) {
          swapAt(x, y, tx, ty);
          return;
        }
      }
      
      // Horizontal drift
      if (rnd() < 0.50) {
        const tx = x + windDir;
        if (inb(tx, y) && isEmptyCell(typeA[idx(tx, y)])) {
          swapAt(x, y, tx, y);
          return;
        }
      }
    }
    
    // Slow falling
    if (belowY < H && trySwapIfHeavier(x,y,x,belowY)) return;
    const bias = wmag > 800 ? windDir : (rnd() < 0.5 ? -1 : 1);
    if (belowY < H && trySwapIfHeavier(x,y,x+bias,belowY)) return;
    if (belowY < H) trySwapIfHeavier(x,y,x-bias,belowY);
    return;
  }
  
  // ==== Other powders: default behavior ====
  if (belowY < H && trySwapIfHeavier(x,y,x,belowY)) return;
  const bias = wmag > WIND_THRESHOLD_LOW ? windDir : (rnd() < 0.5 ? -1 : 1);
  if (belowY < H && trySwapIfHeavier(x,y,x+bias,belowY)) return;
  if (belowY < H) trySwapIfHeavier(x,y,x-bias,belowY);
}

function fluidStep(x,y,t){
  // viscosity
  if (t===E.LAVA && (tick & 3) !== 0) return;
  if (t===E.MUD && (tick & 1) !== 0) return;

  // Get wind with coupling factor for this fluid type
  const wind = getEffectiveWind(x, y, t);
  const vx = wind.vx;
  const vy = wind.vy;
  const coupling = WIND_COUPLING[t] || 0;
  
  // Bias direction from wind (stronger coupling = more responsive)
  let bias = rnd() < 0.5 ? -1 : 1;
  const windThreshold = 500 / Math.max(0.1, coupling); // Lower threshold for high-coupling fluids
  if (Math.abs(vx) > windThreshold) {
    bias = vx < 0 ? -1 : 1;
  }
  const i = idx(x,y);

  // ACID - dissolves organic and metal
  if (t===E.ACID) {
    let strength = dataA[i];
    let dissolved = false;
    
    forNeighbors4(x,y,(nx,ny)=>{
      if (dissolved) return;
      const ni = idx(nx,ny);
      const nt = typeA[ni];
      
      // Dissolve organic materials
      if (IS_ORGANIC[nt] && rnd() < 0.15) {
        typeA[ni] = E.SMOKE;
        dataA[ni] = 60 + irand(40);
        strength -= 20;
        dissolved = true;
        markCellAndNeighbors(nx,ny);
      }
      // Slowly dissolve metal
      else if (nt === E.METAL && rnd() < 0.02) {
        typeA[ni] = E.RUST;
        dataA[ni] = 0;
        strength -= 30;
        dissolved = true;
        markCellAndNeighbors(nx,ny);
      }
      // Neutralize with soap -> foam
      else if (nt === E.SOAP && rnd() < 0.25) {
        typeA[ni] = E.FOAM;
        dataA[ni] = 80 + irand(60);
        typeA[i] = E.FOAM;
        dataA[i] = 80 + irand(60);
        markCellAndNeighbors(nx,ny);
        markCellAndNeighbors(x,y);
        return;
      }
      // Dissolve stone slowly
      else if (nt === E.STONE && rnd() < 0.008) {
        typeA[ni] = E.GRAVEL;
        dataA[ni] = 0;
        strength -= 40;
        markCellAndNeighbors(nx,ny);
      }
    });
    
    dataA[i] = Math.max(0, strength);
    if (strength <= 0) {
      typeA[i] = E.WATER;
      dataA[i] = 128;
      markCellAndNeighbors(x,y);
      return;
    }
  }

  // SOAP - spreads water, creates foam
  if (t===E.SOAP) {
    // Near water: make foam bubbles
    if (hasNeighborOfType(x,y,E.WATER) && rnd() < 0.08) {
      forNeighbors4(x,y,(nx,ny)=>{
        const ni = idx(nx,ny);
        if (typeA[ni]===E.AIR && rnd() < 0.3) {
          typeA[ni] = E.FOAM;
          dataA[ni] = 120 + irand(80);
          markCellAndNeighbors(nx,ny);
        }
      });
    }
    
    // Help water spread faster (lower surface tension)
    forNeighbors4(x,y,(nx,ny)=>{
      const ni = idx(nx,ny);
      if (typeA[ni]===E.WATER) {
        // Push water sideways
        const farX = nx + (nx > x ? 1 : -1);
        if (farX >= 0 && farX < W) {
          const fi = idx(farX, ny);
          if (typeA[fi]===E.AIR && rnd() < 0.15) {
            typeA[fi] = E.WATER;
            dataA[fi] = 128;
            typeA[ni] = E.AIR;
            dataA[ni] = 0;
            markCellAndNeighbors(farX, ny);
            markCellAndNeighbors(nx, ny);
          }
        }
      }
    });
    
    // Soap slowly dissipates
    let life = dataA[i];
    if (rnd() < 0.01) life--;
    if (life <= 0) {
      typeA[i] = E.AIR;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }
    dataA[i] = life;
  }

  // supercooled water: triggers freeze on impurities/ice/pressure
  if (t===E.WATER) {
    const temp = dataA[idx(x,y)]|0; // 128 = neutral
    const supercooled = temp < 110;
    if (supercooled) {
      const ai = aidx(toAirX(x), toAirY(y));
      const p = pField[ai] | 0;
      if (hasNeighborOfType(x,y,E.ICE) || hasNeighborOfType(x,y,E.SAND) || hasNeighborOfType(x,y,E.ASH) || hasNeighborOfType(x,y,E.DIRT)) {
        typeA[idx(x,y)] = E.ICE;
        dataA[idx(x,y)] = 0;
        markCellAndNeighbors(x,y);
        return;
      }
      if (Math.abs(p) > 12000 && rnd() < 0.35) {
        typeA[idx(x,y)] = E.ICE;
        dataA[idx(x,y)] = 0;
        markCellAndNeighbors(x,y);
        return;
      }
    }

    // evaporation -> steam (humidity)
    const aboveY = y-1;
    if (aboveY >= 0) {
      const aboveI = idx(x,aboveY);
      const aboveT = typeA[aboveI];
      if (aboveT===E.AIR || aboveT===E.SMOKE || aboveT===E.STEAM) {
        const ai = aidx(toAirX(x), toAirY(y));
        const p = pField[ai] | 0;
        const wmag = Math.abs(vx) + Math.abs(vy);
        let evap = 0.0015;
        if (temp > 150) evap += (temp - 150) / 5200;
        if (p < -2000) evap += 0.004;
        if (wmag > 8000) evap += 0.003;
        if (rnd() < evap) {
          if (aboveT===E.STEAM) {
            dataA[aboveI] = Math.min(255, dataA[aboveI] + 18);
          } else {
            typeA[aboveI] = E.STEAM;
            dataA[aboveI] = 120 + irand(90);
          }
          dataA[idx(x,y)] = Math.max(0, temp - 1);
          markCellAndNeighbors(x,aboveY);
        }
      }
    }
  }

  const belowY = y+1;
  if (belowY < H) {
    const b = typeA[idx(x,belowY)];
    // oil floats on water
    if (t===E.OIL && b===E.WATER) {
      // don't go down
    } else {
      if (trySwapIfHeavier(x,y,x,belowY)) return;
    }
  }
  // diagonals down
  if (belowY < H && trySwapIfHeavier(x,y,x+bias,belowY)) return;
  if (belowY < H && trySwapIfHeavier(x,y,x-bias,belowY)) return;

  // sideways spread
  if (trySwapIfHeavier(x,y,x+bias,y)) return;
  trySwapIfHeavier(x,y,x-bias,y);

  // ===== WIND-DRIVEN SURFACE DRIFT =====
  // Fluids at the surface are pushed by wind (waves effect)
  // Uses WIND_COUPLING to determine responsiveness
  const surfaceThreshold = 4000 / Math.max(0.1, coupling); // Lower for high-coupling fluids
  if (Math.abs(wind.rawMag) > surfaceThreshold) {
    const aboveY = y-1;
    if (aboveY >= 0) {
      const aboveT = typeA[idx(x,aboveY)];
      // Only surface particles are affected (ones with air/gas above)
      if (aboveT===E.AIR || aboveT===E.SMOKE || aboveT===E.STEAM || aboveT===E.GAS) {
        // Chance to drift increases with wind and coupling
        const driftChance = Math.min(0.8, (wind.mag / 8000) * coupling);
        if (rnd() < driftChance) {
          const sx = vx < 0 ? -1 : (vx > 0 ? 1 : 0);
          if (sx !== 0) trySwapIfHeavier(x,y,x+sx,y);
        }
      }
    }
  }
}

function gasStep(x,y,t){
  // TTL
  const i = idx(x,y);
  if (t !== E.CLOUD && t !== E.GAS && t !== E.FOAM && t !== E.LASER) {
    let ttl = dataA[i];
    if (ttl>0) dataA[i] = ttl-1; else { typeA[i]=E.AIR; dataA[i]=0; markCellAndNeighbors(x,y); return; }
  }

  // Laser beam - fast travel, heats/cuts
  if (t === E.LASER) {
    let ttl = dataA[i];
    if (ttl > 0) dataA[i] = ttl - 1;
    else { typeA[i] = E.AIR; dataA[i] = 0; markCellAndNeighbors(x,y); return; }
    // Laser heats surroundings
    forNeighbors4(x,y,(nx,ny)=>{
      const ni = idx(nx,ny);
      const nt = typeA[ni];
      if (IS_BURNABLE[nt] && rnd() < 0.4) { typeA[ni]=E.FIRE; dataA[ni]=70+irand(80); markCellAndNeighbors(nx,ny); }
      if (nt===E.ICE && rnd() < 0.3) { typeA[ni]=E.WATER; dataA[ni]=128; markCellAndNeighbors(nx,ny); }
      if (nt===E.METAL && rnd() < 0.1) { typeA[ni]=E.LAVA; dataA[ni]=0; markCellAndNeighbors(nx,ny); }
    });
    return;
  }

  // Gas (Methan) - unsichtbar, steigt, entzündlich
  if (t === E.GAS) {
    let ttl = dataA[i];
    if (ttl > 0) dataA[i] = ttl - 1;
    else { typeA[i] = E.AIR; dataA[i] = 0; markCellAndNeighbors(x,y); return; }
    
    // Check for ignition - EXPLOSION!
    if (hasNeighborOfType(x,y,E.FIRE) || hasNeighborOfType(x,y,E.SPARK) || hasNeighborOfType(x,y,E.LAVA)) {
      explodeAt(x, y, 4, 1800);
      return;
    }
    
    // Rise slowly
    const upY = y-1;
    if (upY >= 0 && rnd() < 0.7) {
      if (trySwapIfHeavier(x,y,x,upY)) return;
      if (trySwapIfHeavier(x,y,x+(rnd()<0.5?-1:1),upY)) return;
    }
    // Drift
    if (rnd() < 0.3) {
      const sx = rnd() < 0.5 ? -1 : 1;
      trySwapIfHeavier(x,y,x+sx,y);
    }
    return;
  }

  // Foam - floats, pops
  if (t === E.FOAM) {
    let ttl = dataA[i];
    if (ttl > 0) dataA[i] = ttl - 1;
    else { typeA[i] = E.AIR; dataA[i] = 0; markCellAndNeighbors(x,y); return; }
    
    // Pop faster if no water nearby
    if (!hasNeighborOfType(x,y,E.WATER) && !hasNeighborOfType(x,y,E.SOAP) && rnd() < 0.05) {
      dataA[i] = 0;
    }
    
    // Float up
    const upY = y-1;
    if (upY >= 0 && rnd() < 0.6) {
      if (trySwapIfHeavier(x,y,x,upY)) return;
    }
    // Drift
    if (rnd() < 0.4) {
      const sx = rnd() < 0.5 ? -1 : 1;
      trySwapIfHeavier(x,y,x+sx,y);
    }
    return;
  }

  // ===== WIND-DRIVEN GAS MOVEMENT =====
  // Gases are highly affected by wind - use WIND_COUPLING
  const wind = getEffectiveWind(x, y, t);
  const vx = wind.vx;
  const vy = wind.vy;
  const coupling = WIND_COUPLING[t] || 0.5;
  
  // Direction bias from wind (gases are very responsive)
  let bias = rnd() < 0.5 ? -1 : 1;
  const windThreshold = 300 / Math.max(0.1, coupling);
  if (Math.abs(vx) > windThreshold) {
    bias = vx < 0 ? -1 : 1;
  }

  // steam can condense into cloud when rising/cooling
  if (t === E.STEAM) {
    const ai = aidx(toAirX(x), toAirY(y));
    const p = pField[ai] | 0;
    const steamMass = countNeighbors8(x,y,E.STEAM) + countNeighbors8(x,y,E.CLOUD);
    const cooling = (vy < -2500 * coupling || p < -3000);
    const humid = steamMass >= 4;
    const chance = 0.04 + (steamMass*0.015) + (cooling ? 0.06 : 0);
    if ((cooling || humid) && rnd() < chance) {
      typeA[i] = E.CLOUD;
      dataA[i] = 35 + irand(35);
      markCellAndNeighbors(x,y);
      return;
    }
  }
  let cloudMassLocal = 0;
  if (t === E.CLOUD) {
    cloudMassLocal = cloudMass(x,y);
    let leftCount = 0, rightCount = 0;
    for (let dy=-1; dy<=1; dy++) {
      const ny = y+dy;
      if (ny<0 || ny>=H) continue;
      if (x>0 && typeA[idx(x-1,ny)]===E.CLOUD) leftCount++;
      if (x<W-1 && typeA[idx(x+1,ny)]===E.CLOUD) rightCount++;
    }
    if (leftCount > rightCount) bias = -1;
    else if (rightCount > leftCount) bias = 1;
  }

  const upY = y-1;
  const allowRise = (t !== E.CLOUD) ? true : (cloudMassLocal >= 5 ? rnd() < 0.35 : rnd() < 0.55);
  if (allowRise) {
    if (upY >= 0 && trySwapIfHeavier(x,y,x,upY)) return;
    if (upY >= 0 && trySwapIfHeavier(x,y,x+bias,upY)) return;
    if (upY >= 0) trySwapIfHeavier(x,y,x-bias,upY);
  }
  // drift
  if ((tick & 1) === 0) {
    if (trySwapIfHeavier(x,y,x+bias,y)) return;
    trySwapIfHeavier(x,y,x-bias,y);
  }

  // ===== STRONG WIND ADVECTION FOR GASES =====
  // Gases are carried by wind much more than solids/liquids
  // Higher coupling = more movement
  const wmag = wind.mag;
  const advThreshold = 2000 / Math.max(0.1, coupling);
  const advChance = Math.min(0.75, 0.35 + coupling * 0.4);
  
  if (wmag > advThreshold && rnd() < advChance) {
    const sx = vx < 0 ? -1 : (vx > 0 ? 1 : 0);
    if (sx !== 0 && trySwapIfHeavier(x,y,x+sx,y)) return;
  }
  // Downward push from wind
  if (vy > advThreshold && rnd() < advChance * 0.5) {
    if (trySwapIfHeavier(x,y,x,y+1)) return;
  }
  // Upward push from wind (lift)
  if (vy < -advThreshold && rnd() < advChance * 0.6) {
    if (trySwapIfHeavier(x,y,x,y-1)) return;
  }

  // sparks: faster, more erratic, and can ignite
  if (t === E.SPARK) {
    if (rnd() < 0.45) {
      const sx = (vx < 0 ? -1 : 1) * (rnd()<0.5?1:2);
      const sy = rnd()<0.6 ? -1 : 0;
      const nx = clamp(x+sx, 0, W-1);
      const ny = clamp(y+sy, 0, H-1);
      if (trySwapIfHeavier(x,y,nx,ny)) return;
    }
    if (rnd() < 0.25) {
      forNeighbors4(x,y,(nx,ny)=>{
        const ni = idx(nx,ny);
        if (IS_BURNABLE[typeA[ni]] && rnd() < 0.35) {
          typeA[ni]=E.FIRE; dataA[ni]=70+irand(80);
          markCellAndNeighbors(nx,ny);
        }
      });
    }
  }

  if (t === E.CLOUD) {
    // ===== WETTER-LIFECYCLE =====
    // dataA encoding: bits 0-6 = waterContent (0-127), bit 7 = charged flag
    // Charge builds separately over time when conditions met
    const mass = cloudMassLocal || cloudMass(x,y);
    const ai = aidx(toAirX(x), toAirY(y));
    const rawData = dataA[i] | 0;

    // Extract waterContent and charged state
    let waterContent = rawData & 0x7F;  // 0-127
    let charged = (rawData >> 7) & 1;

    const updraft = (vyField[ai] < -1800) || (pField[ai] < -2500);
    const pressure = pField[ai] | 0;

    // ===== WATER CONTENT DYNAMICS =====
    // Wolken bekommen Wasser aus Dampf/Feuchtigkeit
    if (mass >= 4 && updraft) {
      // Updraft bringt Feuchtigkeit
      waterContent = Math.min(127, waterContent + 1 + irand(2));
    } else if (mass >= 6) {
      // Große Wolken sammeln Feuchtigkeit
      waterContent = Math.min(127, waterContent + irand(2));
    }

    // Wolken verlieren langsam Wasser ohne Nachschub
    if (mass < 3 && (tick & 7) === 0) {
      waterContent = Math.max(0, waterContent - 1);
    }

    // ===== GEWITTER BRAUCHT 3 BEDINGUNGEN =====
    // 1. cloudMass > 5  2. updraft vorhanden  3. waterContent hoch
    const stormConditions =
      mass >= 6 &&
      updraft &&
      waterContent > 80;

    // Charge builds slowly when storm conditions met
    if (stormConditions) {
      if (!charged && rnd() < 0.08) {
        charged = 1;  // Cloud becomes charged
      }
    } else {
      // Storm conditions not met - slowly discharge
      if (charged && rnd() < 0.02) {
        charged = 0;
      }
    }

    // ===== REGEN - entlädt waterContent =====
    // Regen nur wenn genug Wasser UND Masse
    const rainThreshold = 60 + (mass < 5 ? 30 : 0);
    if (waterContent > rainThreshold && mass >= 4) {
      const rainChance = 0.02 + (waterContent - rainThreshold) * 0.0005;
      if (rnd() < rainChance) {
        const by = y + 1;
        if (by < H) {
          const bi = idx(x, by);
          const bt = typeA[bi];
          if (bt === E.AIR || bt === E.SMOKE || bt === E.STEAM) {
            typeA[bi] = E.WATER;
            dataA[bi] = 128;
            markCellAndNeighbors(x, by);
            // Regen entlädt waterContent
            waterContent = Math.max(0, waterContent - 15 - irand(10));
            // Nach Regen: updraft wird gedämpft
            vyField[ai] = (vyField[ai] * 0.85) | 0;
          }
        }
      }
    }

    // ===== BLITZ - nur wenn charged UND alle Bedingungen =====
    if (charged && mass >= 6 && waterContent > 70 && rnd() < 0.015) {
      strikeLightning(x, y);
      // Blitz entlädt die Wolke stark
      waterContent = Math.max(0, waterContent - 40);
      charged = 0;  // Reset charge
      // Updraft wird durch Blitz gestört
      vyField[ai] = (vyField[ai] * 0.6) | 0;
      pField[ai] = clamp(pField[ai] - 800, -30000, 30000);
    }

    // ===== WOLKE LÖST SICH AUF =====
    // Wenn waterContent zu niedrig UND isoliert
    if (waterContent < 15 && mass <= 2 && rnd() < 0.015) {
      typeA[i] = E.STEAM;
      dataA[i] = 90 + irand(40);
      markCellAndNeighbors(x, y);
      return;
    }

    // Save data back
    dataA[i] = (waterContent & 0x7F) | (charged << 7);
  }
}

function fireAndLifeCell(x,y){
  const i = idx(x,y);
  const t = typeA[i];

  if (t===E.FIRE) {
    let ttl = dataA[i];
    if (ttl>0) dataA[i] = ttl-1; else {
      // leave smoke or ash
      if (rnd() < 0.75) { typeA[i]=E.SMOKE; dataA[i]=120+irand(80); }
      else { typeA[i]=E.ASH; dataA[i]=0; }
      markCellAndNeighbors(x,y);
      return;
    }

    // hot air pressure bump
    const ai = aidx(toAirX(x), toAirY(y));
    pField[ai] = clamp(pField[ai] + 150, -30000, 30000);

    // convection: push air upward
    vyField[ai] = clamp(vyField[ai] - 520, -24000, 24000);

    // sparks (short-lived, fast, ignite)
    if (rnd() < 0.08) {
      const sx = clamp(x + irand(3)-1, 0, W-1);
      const sy = clamp(y - 1, 0, H-1);
      const si = idx(sx,sy);
      if (typeA[si]===E.AIR || typeA[si]===E.SMOKE || typeA[si]===E.STEAM) {
        typeA[si]=E.SPARK; dataA[si]=18+irand(18);
        markCellAndNeighbors(sx,sy);
      }
    }

    // spread fire
    forNeighbors4(x,y,(nx,ny)=>{
      const ni = idx(nx,ny);
      const nt = typeA[ni];
      if (IS_BURNABLE[nt] && rnd() < 0.22) {
        typeA[ni]=E.FIRE; dataA[ni]=60+irand(90);
        markCellAndNeighbors(nx,ny);
      }
      // water to steam
      if (nt===E.WATER && rnd()<0.18) {
        typeA[ni]=E.STEAM; dataA[ni]=50+irand(60);
        markCellAndNeighbors(nx,ny);
      }
    });
  }

  if (t===E.DIRT) {
    // moisture dynamics
    let m = dataA[i];
    if (hasNeighborOfType(x,y,E.WATER)) m = Math.min(255, m + 3);
    if (hasNeighborOfType(x,y,E.FIRE))  m = (m>2) ? (m-2) : 0;
    // ash fertilizes (boost moisture capacity feel)
    if (hasNeighborOfType(x,y,E.ASH) && rnd()<0.02) m = Math.min(255, m + 1);
    // very slow diffusion to nearby dirt
    if ((tick & 7) === 0) {
      let sum=0,cnt=0;
      forNeighbors4(x,y,(nx,ny)=>{
        const ni = idx(nx,ny);
        if (typeA[ni]===E.DIRT){ sum += dataA[ni]; cnt++; }
      });
      if (cnt) {
        const avg = (sum/cnt)|0;
        m = (m + ((avg - m)*0.08))|0;
      }
    }
    // evaporation from wet soil
    if (m > 140 && y > 0) {
      const aboveI = idx(x,y-1);
      const aboveT = typeA[aboveI];
      if ((aboveT===E.AIR || aboveT===E.SMOKE) && rnd() < 0.002) {
        typeA[aboveI] = E.STEAM;
        dataA[aboveI] = 110 + irand(90);
        m = Math.max(0, m - 3);
        markCellAndNeighbors(x,y-1);
      }
    }
    if (m !== dataA[i]) {
      dataA[i]=m;
      markCellAndNeighbors(x,y);
    }
  }

  if (t===E.SEED) {
    // ===== SAMEN-KEIMUNG MIT FEEDBACK =====
    // dataA encoding: bits 0-6 = age/progress, bit 7 = germinating flag
    const rawData = dataA[i] | 0;
    let age = rawData & 0x7F;
    let germinating = (rawData >> 7) & 1;

    const belowY = y + 1;
    const hasDirtBelow = belowY < H && typeA[idx(x, belowY)] === E.DIRT;
    const hasWater = hasNeighborOfType(x, y, E.WATER);
    const moist = hasDirtBelow ? dataA[idx(x, belowY)] : 0;

    // Bedingungen für Keimung
    const canGerminate = hasDirtBelow && (moist > 35 || hasWater);

    if (canGerminate) {
      germinating = 1;  // Zeigt "ich arbeite"
      age = Math.min(127, age + 1 + (hasWater ? 1 : 0));

      // Schnellere Keimung mit mehr Wasser
      const germThreshold = hasWater ? 25 : 40;
      const germChance = hasWater ? 0.35 : 0.20;

      if (age > germThreshold && rnd() < germChance) {
        typeA[i] = E.SPROUT;
        dataA[i] = 0;
        // Verbrauche etwas Feuchtigkeit
        if (hasDirtBelow) {
          dataA[idx(x, belowY)] = Math.max(0, dataA[idx(x, belowY)] - 5);
        }
      } else {
        dataA[i] = (age & 0x7F) | (germinating << 7);
      }
      markCellAndNeighbors(x, y);
    } else {
      // Nicht keimend - Samen trocknet langsam / stirbt
      germinating = 0;
      if (age > 0 && (tick & 15) === 0) {
        age = Math.max(0, age - 1);  // Fortschritt geht verloren
      }
      // Nach langer Zeit ohne Bedingungen: Samen stirbt
      if (age === 0 && rawData > 0 && rnd() < 0.005) {
        typeA[i] = E.ASH;  // Toter Samen
        dataA[i] = 0;
        markCellAndNeighbors(x, y);
        return;
      }
      dataA[i] = (age & 0x7F) | (germinating << 7);
    }
  }

  if (t===E.SPROUT || t===E.PLANT) {
    // ===== PFLANZENWACHSTUM MIT FEEDBACK =====
    let age = dataA[i];
    const moist = bestNeighborMoisture(x,y);
    const hasWater = hasNeighborOfType(x,y,E.WATER);
    const hasFire = hasNeighborOfType(x,y,E.FIRE);

    // Wachstum bei guten Bedingungen
    if (moist > 20 || hasWater) {
      // Schnelleres Wachstum mit direktem Wasserkontakt
      const growthRate = hasWater ? 2 : 1;
      if (rnd() < 0.75) age = Math.min(255, age + growthRate);

      // Verbrauche Feuchtigkeit aus Erde
      if ((tick & 3) === 0) {
        const by = y + 1;
        if (by < H) {
          const bi = idx(x, by);
          if (typeA[bi] === E.DIRT && dataA[bi] > 0 && rnd() < 0.35) {
            dataA[bi] = Math.max(0, dataA[bi] - 1);
          }
        }
      }
    } else {
      // Ohne Wasser: langsames Welken
      if ((tick & 7) === 0 && age > 0) {
        age = Math.max(0, age - 1);
      }
    }

    // Feuer in der Nähe: schneller sterben
    if (hasFire && rnd() < 0.15) {
      typeA[i] = E.FIRE;
      dataA[i] = 60 + irand(80);
      markCellAndNeighbors(x, y);
      return;
    }

    // Upgrade Sprout -> Plant
    if (t === E.SPROUT && age > 20) {
      typeA[i] = E.PLANT;
      age = 30;
    }

    dataA[i] = age;

    // Nach oben wachsen
    if (age > 15 && rnd() < 0.12) {
      const upY = y - 1;
      if (upY >= 0) {
        const ui = idx(x, upY);
        if (typeA[ui] === E.AIR) {
          typeA[ui] = E.PLANT;
          dataA[ui] = 15;
          markCellAndNeighbors(x, upY);
        }
      }
    }

    // Zu Holz werden
    if (t === E.PLANT && age > 120 && rnd() < 0.02) {
      typeA[i] = E.WOOD;
      dataA[i] = 0;
      markCellAndNeighbors(x, y);
    }

    // Sterben wenn zu trocken
    if (age < 5 && moist < 8 && !hasWater && rnd() < 0.015) {
      typeA[i] = E.ASH;
      dataA[i] = 0;
      markCellAndNeighbors(x, y);
    }
  }

  if (t===E.LAVA) {
    // ===== LAVA-PHYSIK (realistisch) =====
    // dataA für Lava: bits 0-6 = Hitze (0-127), bit 7 = Kruste flag
    const rawData = dataA[i] | 0;
    let heat = rawData & 0x7F;       // 0-127
    let crusted = (rawData >> 7) & 1;

    // ===== HITZE-VERLUST (Lava kühlt langsam ab) =====
    // Schneller wenn an Luft, langsamer wenn umgeben von Lava
    const lavaNeighbors = countNeighbors8(x,y,E.LAVA);
    const hasAir = hasNeighborOfType(x,y,E.AIR);
    const hasWater = hasNeighborOfType(x,y,E.WATER);

    if (hasAir && lavaNeighbors < 4) {
      // An der Oberfläche: kühlt schneller
      heat = Math.max(0, heat - 1 - (crusted ? 0 : irand(2)));
    } else if (lavaNeighbors >= 6) {
      // Umgeben von Lava: bleibt heiß
      heat = Math.min(127, heat + irand(2));
    }

    // ===== KRUSTE BILDEN =====
    // Wenn Hitze sinkt UND an Oberfläche -> Kruste
    if (!crusted && heat < 50 && hasAir && rnd() < 0.08) {
      crusted = 1;
    }
    // Kruste kann aufbrechen bei hoher Hitze von unten
    if (crusted && heat > 90 && rnd() < 0.05) {
      crusted = 0;
    }

    // ===== WASSER-INTERAKTION (Steam + Stone/Gravel + Shockwave) =====
    if (hasWater && rnd() < 0.40) {
      let waterCount = 0;
      forNeighbors4(x,y,(nx,ny)=>{ if (typeA[idx(nx,ny)]===E.WATER) waterCount++; });

      // Schnelle Abkühlung = mehr Steam & Gravel (pumice)
      const fastQuench = waterCount >= 2 || heat > 80;
      typeA[i] = fastQuench ? E.GRAVEL : E.STONE;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);

      // Wasser zu Steam
      forNeighbors4(x,y,(nx,ny)=>{
        const ni = idx(nx,ny);
        if (typeA[ni]===E.WATER) {
          typeA[ni] = E.STEAM;
          dataA[ni] = 60+irand(60);
          markCellAndNeighbors(nx,ny);
        }
      });

      // Druckstoß (stärker bei mehr Wasser)
      const ai = aidx(toAirX(x), toAirY(y));
      const shockStrength = fastQuench ? 2200 + waterCount * 400 : 1200;
      pField[ai] = clamp(pField[ai] + shockStrength, -30000, 30000);
      applyShockwave(x, y, shockStrength / 2);
      return;
    }

    // ===== KONTAKT-EFFEKTE (Sand/Earth/Stone erhitzen) =====
    forNeighbors4(x,y,(nx,ny)=>{
      const ni = idx(nx,ny);
      const nt = typeA[ni];

      // Sand -> Glass (bei hoher Hitze)
      if (nt === E.SAND && heat > 80 && rnd() < 0.04) {
        typeA[ni] = E.STONE;  // Verwende Stone als "Glass"
        dataA[ni] = 0;
        markCellAndNeighbors(nx,ny);
      }

      // Dirt -> "gebackene Erde" (Stone)
      if (nt === E.DIRT && heat > 60 && rnd() < 0.02) {
        typeA[ni] = E.GRAVEL;  // Gebackene Erde = Kiesel
        dataA[ni] = 0;
        markCellAndNeighbors(nx,ny);
      }

      // Ice -> Water -> Steam schnell
      if (nt === E.ICE && rnd() < 0.25) {
        typeA[ni] = E.STEAM;
        dataA[ni] = 80 + irand(60);
        markCellAndNeighbors(nx,ny);
      }

      // Burnable -> Fire
      if (IS_BURNABLE[nt] && !crusted && rnd() < 0.25) {
        typeA[ni] = E.FIRE;
        dataA[ni] = 70 + irand(80);
        markCellAndNeighbors(nx,ny);
      }
    });

    // ===== ERSTARREN (wenn zu kalt) =====
    if (heat < 15 && rnd() < 0.03) {
      // Kalte Lava wird zu Stone
      typeA[i] = crusted ? E.STONE : E.GRAVEL;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }

    // Hitze-Ausstrahlung (erwärmt Luft)
    if (!crusted && heat > 50) {
      const ai = aidx(toAirX(x), toAirY(y));
      pField[ai] = clamp(pField[ai] + 80 + heat, -30000, 30000);
      vyField[ai] = clamp(vyField[ai] - 200, -24000, 24000); // Aufwärtsdrift
    }

    // Speichere Daten
    dataA[i] = (heat & 0x7F) | (crusted << 7);
  }

  if (t===E.ICE) {
    if (hasNeighborOfType(x,y,E.FIRE) || hasNeighborOfType(x,y,E.LAVA)) {
      if (rnd() < 0.06) {
        typeA[i]=E.WATER; dataA[i]=128; markCellAndNeighbors(x,y);
      }
    }
  }

  // METAL - conducts heat, rusts with water+air
  if (t===E.METAL) {
    const hasWater = hasNeighborOfType(x,y,E.WATER);
    const hasAir = hasNeighborOfType(x,y,E.AIR);
    const hasSteam = hasNeighborOfType(x,y,E.STEAM);
    
    // Rust formation: water + oxygen (air/steam)
    if (hasWater && (hasAir || hasSteam) && rnd() < 0.003) {
      typeA[i] = E.RUST;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }
    
    // Acid accelerates rusting
    if (hasNeighborOfType(x,y,E.ACID) && rnd() < 0.04) {
      typeA[i] = E.RUST;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
      return;
    }
    
    // Melt from lava
    if (hasNeighborOfType(x,y,E.LAVA) && rnd() < 0.02) {
      typeA[i] = E.LAVA;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
    }
  }

  // VINE - grows sideways and climbs
  if (t===E.VINE) {
    let age = dataA[i];
    const moist = bestNeighborMoisture(x,y);
    const hasWater = hasNeighborOfType(x,y,E.WATER);
    
    if (moist > 15 || hasWater) {
      age = Math.min(255, age + 1);
      dataA[i] = age;
      
      // Grow in multiple directions
      if (age > 8 && rnd() < 0.12) {
        // Try to climb up on wood/stone
        const canClimbUp = y > 0 && (
          (x > 0 && (typeA[idx(x-1,y)] === E.WOOD || typeA[idx(x-1,y)] === E.STONE)) ||
          (x < W-1 && (typeA[idx(x+1,y)] === E.WOOD || typeA[idx(x+1,y)] === E.STONE))
        );
        
        const dirs = [];
        // Prefer sideways and up
        if (x > 0 && typeA[idx(x-1,y)] === E.AIR) dirs.push({dx:-1, dy:0, w:3});
        if (x < W-1 && typeA[idx(x+1,y)] === E.AIR) dirs.push({dx:1, dy:0, w:3});
        if (canClimbUp && y > 0 && typeA[idx(x,y-1)] === E.AIR) dirs.push({dx:0, dy:-1, w:4});
        if (y < H-1 && typeA[idx(x,y+1)] === E.AIR) dirs.push({dx:0, dy:1, w:1});
        // Diagonal climb
        if (x > 0 && y > 0 && typeA[idx(x-1,y-1)] === E.AIR && typeA[idx(x-1,y)] !== E.AIR) 
          dirs.push({dx:-1, dy:-1, w:2});
        if (x < W-1 && y > 0 && typeA[idx(x+1,y-1)] === E.AIR && typeA[idx(x+1,y)] !== E.AIR) 
          dirs.push({dx:1, dy:-1, w:2});
        
        if (dirs.length > 0) {
          // Weighted random selection
          const totalW = dirs.reduce((s,d) => s + d.w, 0);
          let r = rnd() * totalW;
          let chosen = dirs[0];
          for (const d of dirs) {
            r -= d.w;
            if (r <= 0) { chosen = d; break; }
          }
          
          const nx = x + chosen.dx;
          const ny = y + chosen.dy;
          if (inb(nx,ny) && typeA[idx(nx,ny)] === E.AIR) {
            typeA[idx(nx,ny)] = E.VINE;
            dataA[idx(nx,ny)] = 0;
            markCellAndNeighbors(nx,ny);
          }
        }
      }
    }
    
    // Die if too dry
    if (age > 5 && moist < 5 && !hasWater && rnd() < 0.008) {
      typeA[i] = E.ASH;
      dataA[i] = 0;
      markCellAndNeighbors(x,y);
    }
  }
}

// === NEW ELEMENT FUNCTIONS ===

// Explosion - creates pressure wave, fire, sparks
function explodeAt(cx, cy, radius, pressure) {
  const rr = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d2 = dx*dx + dy*dy;
      if (d2 > rr) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inb(nx, ny)) continue;
      
      const ni = idx(nx, ny);
      const nt = typeA[ni];
      const fall = 1 - Math.sqrt(d2) / radius;
      
      // Inner core: fire
      if (d2 < rr * 0.25) {
        if (!IS_SOLID[nt] || nt === E.WOOD) {
          typeA[ni] = E.FIRE;
          dataA[ni] = 80 + irand(80);
          markCellAndNeighbors(nx, ny);
        }
      }
      // Outer ring: sparks and destruction
      else if (d2 < rr * 0.7) {
        if (nt === E.AIR || nt === E.SMOKE || nt === E.STEAM || nt === E.GAS) {
          if (rnd() < 0.4) {
            typeA[ni] = E.SPARK;
            dataA[ni] = 15 + irand(20);
          } else if (rnd() < 0.3) {
            typeA[ni] = E.FIRE;
            dataA[ni] = 50 + irand(60);
          }
          markCellAndNeighbors(nx, ny);
        } else if (IS_BURNABLE[nt]) {
          typeA[ni] = E.FIRE;
          dataA[ni] = 70 + irand(80);
          markCellAndNeighbors(nx, ny);
        }
      }
      // Destroy weak materials
      if (nt === E.WOOD && rnd() < fall * 0.5) {
        typeA[ni] = E.ASH;
        dataA[ni] = 0;
        markCellAndNeighbors(nx, ny);
      }
      if (nt === E.GRAVEL && rnd() < fall * 0.3) {
        typeA[ni] = E.SAND;
        dataA[ni] = 0;
        markCellAndNeighbors(nx, ny);
      }
    }
  }
  
  // Shockwave
  applyShockwave(cx, cy, pressure);
  
  // Chain reaction for nearby explosives
  for (let dy = -radius-2; dy <= radius+2; dy++) {
    for (let dx = -radius-2; dx <= radius+2; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inb(nx, ny)) continue;
      const ni = idx(nx, ny);
      const nt = typeA[ni];
      if (nt === E.NITRO || nt === E.GAS) {
        dataA[ni] = 255; // trigger explosion next tick
      }
    }
  }
  
  // Remove original cell
  typeA[idx(cx,cy)] = E.FIRE;
  dataA[idx(cx,cy)] = 60 + irand(60);
  markCellAndNeighbors(cx, cy);
}

// Firework explosion - colorful sparks in all directions
function fireworkExplode(cx, cy) {
  const radius = 6 + irand(4);
  const numSparks = 25 + irand(20);
  
  for (let i = 0; i < numSparks; i++) {
    const angle = (i / numSparks) * Math.PI * 2 + rnd() * 0.3;
    const dist = 2 + irand(radius);
    const nx = cx + Math.round(Math.cos(angle) * dist);
    const ny = cy + Math.round(Math.sin(angle) * dist);
    
    if (!inb(nx, ny)) continue;
    const ni = idx(nx, ny);
    const nt = typeA[ni];
    
    if (nt === E.AIR || nt === E.SMOKE || nt === E.STEAM) {
      typeA[ni] = E.SPARK;
      // Store color info in data for rendering
      dataA[ni] = 30 + irand(40) + (irand(4) << 6); // TTL + color bits
      markCellAndNeighbors(nx, ny);
    }
  }
  
  // Small pressure burst
  applyShockwave(cx, cy, 1200);
  
  // Remove firework
  typeA[idx(cx,cy)] = E.SMOKE;
  dataA[idx(cx,cy)] = 60 + irand(40);
  markCellAndNeighbors(cx, cy);
}

// Ant behavior - simple swarm AI
function antStep(x, y) {
  const i = idx(x, y);
  let dir = dataA[i] & 3; // 0=left, 1=right, 2=up, 3=down
  
  // Random direction change
  if (rnd() < 0.05) {
    dir = irand(4);
    dataA[i] = (dataA[i] & ~3) | dir;
  }
  
  // Movement deltas
  const moves = [{dx:-1,dy:0}, {dx:1,dy:0}, {dx:0,dy:-1}, {dx:0,dy:1}];
  const m = moves[dir];
  
  // Try primary direction
  let nx = x + m.dx;
  let ny = y + m.dy;
  
  // Gravity - always try to fall if no ground
  const belowY = y + 1;
  if (belowY < H) {
    const belowT = typeA[idx(x, belowY)];
    if (belowT === E.AIR || belowT === E.WATER) {
      if (trySwapIfHeavier(x, y, x, belowY)) return;
    }
  }
  
  // Look for seeds to collect
  let foundSeed = false;
  forNeighbors4(x, y, (sx, sy) => {
    if (foundSeed) return;
    const si = idx(sx, sy);
    if (typeA[si] === E.SEED && rnd() < 0.2) {
      // "Carry" seed - convert to ant carrying (stored in upper bits)
      dataA[i] = (dataA[i] & 3) | 4; // Set carrying flag
      typeA[si] = E.AIR;
      dataA[si] = 0;
      markCellAndNeighbors(sx, sy);
      foundSeed = true;
    }
  });
  
  // If carrying, occasionally drop
  if ((dataA[i] & 4) && rnd() < 0.01) {
    // Drop seed nearby
    forNeighbors4(x, y, (sx, sy) => {
      const si = idx(sx, sy);
      if (typeA[si] === E.AIR) {
        typeA[si] = E.SEED;
        dataA[si] = 0;
        dataA[i] = dataA[i] & 3; // Clear carrying flag
        markCellAndNeighbors(sx, sy);
        return;
      }
    });
  }
  
  // Build tiny mounds on dirt
  if (rnd() < 0.003 && y > 0) {
    const belowI = idx(x, y+1);
    if (inb(x, y+1) && typeA[belowI] === E.DIRT) {
      const aboveI = idx(x, y-1);
      if (inb(x, y-1) && typeA[aboveI] === E.AIR) {
        typeA[aboveI] = E.DIRT;
        dataA[aboveI] = 30;
        markCellAndNeighbors(x, y-1);
      }
    }
  }
  
  // Try to move
  if (inb(nx, ny)) {
    const ni = idx(nx, ny);
    const nt = typeA[ni];
    if (nt === E.AIR) {
      swapAt(x, y, nx, ny);
      return;
    }
    // Climb over obstacles
    if (IS_SOLID[nt] || IS_POWDER[nt]) {
      const upY = y - 1;
      if (upY >= 0 && typeA[idx(x, upY)] === E.AIR) {
        swapAt(x, y, x, upY);
        return;
      }
    }
  }
  
  // Reverse direction if stuck
  dataA[i] = (dataA[i] & ~3) | ((dir + 2) % 4);
}

// Laser beam - shoots in a direction
function shootLaser(startX, startY, dir) {
  let x = startX;
  let y = startY;
  const maxDist = 100;
  
  for (let d = 0; d < maxDist; d++) {
    x += Math.round(dir.x);
    y += Math.round(dir.y);
    
    if (!inb(x, y)) break;
    
    const i = idx(x, y);
    const t = typeA[i];
    
    // Hit solid - stop
    if (IS_SOLID[t] && t !== E.ICE) {
      if (t === E.METAL) {
        // Heat metal
        if (rnd() < 0.1) {
          typeA[i] = E.LAVA;
          markCellAndNeighbors(x, y);
        }
      }
      break;
    }
    
    // Create laser trail
    if (t === E.AIR || t === E.SMOKE || t === E.STEAM || t === E.GAS) {
      typeA[i] = E.LASER;
      dataA[i] = 3 + irand(3); // Short TTL
      markCellAndNeighbors(x, y);
      
      // Ionize air -> create plasma sparks occasionally
      if (rnd() < 0.05) {
        typeA[i] = E.SPARK;
        dataA[i] = 8 + irand(8);
      }
    }
    
    // Burn through burnables
    if (IS_BURNABLE[t]) {
      typeA[i] = E.FIRE;
      dataA[i] = 70 + irand(80);
      markCellAndNeighbors(x, y);
      if (rnd() < 0.7) break; // Sometimes penetrates
    }
    
    // Melt ice
    if (t === E.ICE) {
      typeA[i] = E.WATER;
      dataA[i] = 128;
      markCellAndNeighbors(x, y);
    }
    
    // Evaporate water
    if (t === E.WATER) {
      typeA[i] = E.STEAM;
      dataA[i] = 60 + irand(60);
      markCellAndNeighbors(x, y);
    }
    
    // Ignite gas
    if (t === E.GAS) {
      explodeAt(x, y, 4, 1800);
      break;
    }
    
    // Detonate nitro
    if (t === E.NITRO) {
      explodeAt(x, y, 8, 4500);
      break;
    }
  }
}

function forNeighbors4(x,y,fn){
  if (x>0) fn(x-1,y);
  if (x<W-1) fn(x+1,y);
  if (y>0) fn(x,y-1);
  if (y<H-1) fn(x,y+1);
}

function countNeighbors8(x,y,tNeed){
  let count = 0;
  for (let dy=-1; dy<=1; dy++) {
    for (let dx=-1; dx<=1; dx++) {
      if (dx===0 && dy===0) continue;
      const nx = x+dx, ny = y+dy;
      if (!inb(nx,ny)) continue;
      if (typeA[idx(nx,ny)]===tNeed) count++;
    }
  }
  return count;
}

function hasNeighborOfType(x,y,tNeed){
  let ok = false;
  forNeighbors4(x,y,(nx,ny)=>{ if (typeA[idx(nx,ny)]===tNeed) ok = true; });
  return ok;
}

function hasNeighborBurnable(x,y){
  let ok = false;
  forNeighbors4(x,y,(nx,ny)=>{ if (IS_BURNABLE[typeA[idx(nx,ny)]]) ok = true; });
  return ok;
}

function bestNeighborMoisture(x,y){
  let best = 0;
  forNeighbors4(x,y,(nx,ny)=>{
    const ni = idx(nx,ny);
    if (typeA[ni]===E.DIRT) best = Math.max(best, dataA[ni]);
  });
  return best;
}

function cloudMass(x,y){
  let count = 0;
  for (let dy=-1; dy<=1; dy++) {
    for (let dx=-1; dx<=1; dx++) {
      if (dx===0 && dy===0) continue;
      const nx = x+dx, ny = y+dy;
      if (!inb(nx,ny)) continue;
      if (typeA[idx(nx,ny)]===E.CLOUD) count++;
    }
  }
  return count;
}

function findLightningTarget(x, y) {
  // ===== BLITZ-ZIEL FINDEN =====
  // Zieht zu: Metall > Wasser > hohe Punkte > Solids
  let bestX = x | 0;
  let bestScore = 1e9;
  let bestY = H;
  const radius = 12;  // Erhöht für bessere Reichweite

  for (let dx = -radius; dx <= radius; dx++) {
    const xx = clamp(x + dx, 0, W - 1);
    for (let yy = y + 1; yy < H; yy++) {
      const t = typeA[idx(xx, yy)];
      if (t === E.AIR || t === E.SMOKE || t === E.STEAM || t === E.CLOUD) continue;

      // Scoring: niedriger = besser
      let score = yy + Math.abs(dx) * 1.5;  // Basis: Distanz

      // METALL: stark bevorzugt (Blitzableiter!)
      if (t === E.METAL) score -= 25;

      // WASSER: leitet gut
      else if (t === E.WATER || t === E.ACID) score -= 12;

      // Hohe Punkte (Bäume/Gebäude)
      else if (IS_SOLID[t] || t === E.WOOD) score -= 8;

      // Höhe bonus (höhere Objekte ziehen mehr an)
      if (yy < y + 30) score -= (30 - (yy - y)) * 0.3;

      if (score < bestScore) {
        bestScore = score;
        bestX = xx;
        bestY = yy;
      }
      break;
    }
  }
  return { x: bestX, y: bestY };
}

function applyShockwave(cx,cy,strength=2400){
  const ax0 = toAirX(cx);
  const ay0 = toAirY(cy);
  const r = 6;
  for (let ay=ay0-r; ay<=ay0+r; ay++) {
    if (ay<0 || ay>=aH) continue;
    for (let ax=ax0-r; ax<=ax0+r; ax++) {
      if (ax<0 || ax>=aW) continue;
      const dx = ax-ax0, dy = ay-ay0;
      const d2 = dx*dx + dy*dy;
      if (d2 > r*r) continue;
      const fall = 1 - (Math.sqrt(d2) / r);
      const ai = aidx(ax,ay);
      pField[ai] = clamp(pField[ai] + strength*fall, -30000, 30000);
      vxField[ai] = clamp(vxField[ai] + dx*240*fall, -24000, 24000);
      vyField[ai] = clamp(vyField[ai] + dy*240*fall, -24000, 24000);
    }
  }
}

function strikeLightning(x, y) {
  // ===== BLITZ MIT VERZWEIGUNGEN =====
  // Hauptstrahl + mögliche Seitenäste
  const branches = [{ x: x | 0, y: y | 0, active: true, main: true }];
  const target = findLightningTarget(x, y);
  const maxSteps = Math.min(H - y, 120);

  // Verzweigungs-Chancen
  const BRANCH_CHANCE = 0.08;
  const MAX_BRANCHES = 4;

  for (let s = 0; s < maxSteps && branches.some(b => b.active); s++) {
    for (let bi = 0; bi < branches.length; bi++) {
      const b = branches[bi];
      if (!b.active) continue;

      // ===== BEWEGUNG MIT JITTER =====
      const dx = target.x - b.x;
      const steerChance = b.main ? 0.72 : 0.55;  // Hauptstrahl zielt genauer

      if (dx !== 0 && rnd() < steerChance) {
        b.x = clamp(b.x + (dx > 0 ? 1 : -1), 0, W - 1);
      } else {
        // Zufällige Abweichung (mehr bei Nebenästen)
        const jitter = b.main ? irand(3) - 1 : irand(5) - 2;
        b.x = clamp(b.x + jitter, 0, W - 1);
      }
      b.y = clamp(b.y + 1, 0, H - 1);

      const i = idx(b.x, b.y);
      const t = typeA[i];

      // ===== VERZWEIGUNG ERSTELLEN =====
      if (b.main && branches.length < MAX_BRANCHES && rnd() < BRANCH_CHANCE) {
        const branchDir = rnd() < 0.5 ? -1 : 1;
        branches.push({
          x: clamp(b.x + branchDir * 2, 0, W - 1),
          y: b.y,
          active: true,
          main: false
        });
      }

      // ===== WASSER GETROFFEN =====
      if (t === E.WATER) {
        typeA[i] = E.STEAM;
        dataA[i] = 60 + irand(60);
        markCellAndNeighbors(b.x, b.y);

        // Wasser leitet Blitz weiter - extra Sparks!
        const spreadRadius = b.main ? 4 : 2;
        applyShockwave(b.x, b.y, b.main ? 3200 : 1800);

        for (let dy = -spreadRadius; dy <= spreadRadius; dy++) {
          for (let dx2 = -spreadRadius; dx2 <= spreadRadius; dx2++) {
            const d2 = dx2 * dx2 + dy * dy;
            if (d2 < 2 || d2 > spreadRadius * spreadRadius) continue;
            const nx = b.x + dx2, ny = b.y + dy;
            if (!inb(nx, ny)) continue;
            const ni = idx(nx, ny);
            const nt = typeA[ni];
            if (nt === E.WATER && rnd() < 0.4) {
              typeA[ni] = E.STEAM;
              dataA[ni] = 50 + irand(50);
              markCellAndNeighbors(nx, ny);
            } else if (nt === E.AIR || nt === E.SMOKE || nt === E.STEAM) {
              typeA[ni] = E.SPARK;
              dataA[ni] = 10 + irand(15);
              markCellAndNeighbors(nx, ny);
            }
          }
        }
        b.active = false;
        continue;
      }

      // ===== METALL GETROFFEN (leitet perfekt) =====
      if (t === E.METAL) {
        // Metall absorbiert den Blitz, starke Shockwave
        applyShockwave(b.x, b.y, b.main ? 3500 : 2000);
        const ai = aidx(toAirX(b.x), toAirY(b.y));
        pField[ai] = clamp(pField[ai] + 3000, -30000, 30000);

        // Sparks fliegen vom Metall weg
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx2 = -3; dx2 <= 3; dx2++) {
            if (dx2 === 0 && dy === 0) continue;
            const nx = b.x + dx2, ny = b.y + dy;
            if (!inb(nx, ny)) continue;
            const ni = idx(nx, ny);
            if ((typeA[ni] === E.AIR || typeA[ni] === E.SMOKE) && rnd() < 0.5) {
              typeA[ni] = E.SPARK;
              dataA[ni] = 15 + irand(20);
              markCellAndNeighbors(nx, ny);
            }
          }
        }
        b.active = false;
        continue;
      }

      // ===== ANDERES SOLID GETROFFEN =====
      if (IS_SOLID[t]) {
        const ai = aidx(toAirX(b.x), toAirY(b.y));
        pField[ai] = clamp(pField[ai] + 2400, -30000, 30000);
        applyShockwave(b.x, b.y, b.main ? 2800 : 1500);

        for (let dy = -2; dy <= 2; dy++) {
          for (let dx2 = -2; dx2 <= 2; dx2++) {
            const d2 = dx2 * dx2 + dy * dy;
            if (d2 < 2 || d2 > 8) continue;
            const nx = b.x + dx2, ny = b.y + dy;
            if (!inb(nx, ny)) continue;
            const ni = idx(nx, ny);
            if (typeA[ni] === E.AIR || typeA[ni] === E.SMOKE || typeA[ni] === E.STEAM) {
              typeA[ni] = E.SPARK;
              dataA[ni] = 10 + irand(12);
              markCellAndNeighbors(nx, ny);
            }
          }
        }
        b.active = false;
        continue;
      }

      // ===== DURCH LUFT/GASE =====
      if (t === E.AIR || t === E.SMOKE || t === E.STEAM || t === E.CLOUD) {
        // Hauptstrahl: mehr Feuer/Sparks
        const sparkChance = b.main ? 0.70 : 0.45;
        const fireChance = b.main ? 0.25 : 0.10;

        if (rnd() < sparkChance) {
          typeA[i] = E.SPARK;
          dataA[i] = 10 + irand(12);
        } else if (rnd() < fireChance) {
          typeA[i] = E.FIRE;
          dataA[i] = 50 + irand(70);
        }
        markCellAndNeighbors(b.x, b.y);
      } else if (IS_BURNABLE[t]) {
        typeA[i] = E.FIRE;
        dataA[i] = 70 + irand(80);
        markCellAndNeighbors(b.x, b.y);
      }

      // Druck entlang des Pfads
      const ai = aidx(toAirX(b.x), toAirY(b.y));
      pField[ai] = clamp(pField[ai] + (b.main ? 1100 : 500), -30000, 30000);

      // Nebenäste sterben früher ab
      if (!b.main && s > 8 && rnd() < 0.15) {
        b.active = false;
      }
    }
  }
}

function updateAir(){
  // ===== VOLLSTÄNDIGE WIND-PHYSIK =====
  // Wind hat 3 Haupteigenschaften:
  // 1. ADVECTION - Wind trägt sich selbst (Velocity bewegt Velocity)
  // 2. DECAY - Wind verliert langsam Energie
  // 3. DIFFUSION - Wind verteilt sich in der Umgebung

  const pDiff = 0.26;  // Druck-Diffusionsrate (erhöht für bessere Ausbreitung)
  const damp = clamp((state.windDamp||93) / 100, 0.80, 0.99);
  const k = 0.42;  // Druck-zu-Geschwindigkeit Faktor (erhöht)

  // === Decay Rate ===
  // Niedrigerer damp = schnellerer Decay (Wind stirbt schneller)
  const velocityDecay = 0.965 + (damp - 0.80) * 0.17; // 0.965 to 0.998

  // Hintergrund-Drift für lebendige Welt
  updateAmbientWind();

  // Global Wind Update (UI-gesteuert)
  const gStr = clamp(state.globalWindStrength|0, 0, 100);
  const gAng = ((state.globalWindAngle||0) * Math.PI) / 180;
  const gVXTarget = Math.cos(gAng) * gStr * 240;
  const gVYTarget = Math.sin(gAng) * gStr * 240;
  globalVX += (gVXTarget - globalVX) * 0.08;
  globalVY += (gVYTarget - globalVY) * 0.08;

  // Solidity-Feld für Hindernis-Interaktion
  updateSolidField();

  // ===== PHASE 1: PRESSURE DIFFUSION =====
  // Druck breitet sich zu Nachbarn aus (glattere Gradienten)
  for (let ay=0; ay<aH; ay++) {
    const row = ay*aW;
    for (let ax=0; ax<aW; ax++) {
      const i = row + ax;
      const p = pField[i];
      let sum = 0, cnt = 0;
      if (ax>0) { sum += pField[i-1]; cnt++; }
      if (ax<aW-1) { sum += pField[i+1]; cnt++; }
      if (ay>0) { sum += pField[i-aW]; cnt++; }
      if (ay<aH-1) { sum += pField[i+aW]; cnt++; }
      const avg = cnt ? (sum/cnt) : 0;
      const np = (p + ((avg - p) * pDiff)) | 0;
      pNext[i] = clamp(np, -30000, 30000);
    }
  }
  // Buffer tauschen
  let tmp = pField; pField = pNext; pNext = tmp;

  // ===== PHASE 2: PRESSURE GRADIENT → VELOCITY =====
  // Druckdifferenz erzeugt Wind
  for (let ay=0; ay<aH; ay++) {
    const row = ay*aW;
    for (let ax=0; ax<aW; ax++) {
      const i = row + ax;
      const p = pField[i];
      const pl = ax>0 ? pField[i-1] : p;
      const pr = ax<aW-1 ? pField[i+1] : p;
      const pu = ay>0 ? pField[i-aW] : p;
      const pd = ay<aH-1 ? pField[i+aW] : p;

      let vx = vxField[i];
      let vy = vyField[i];

      // Druckgradient + Decay anwenden
      vx = (vx * damp + (pl - pr) * k) | 0;
      vy = (vy * damp + (pu - pd) * k) | 0;

      // Sanfte Anpassung an globalen Wind
      vx = (vx + ((globalVX - vx) * 0.025)) | 0;
      vy = (vy + ((globalVY - vy) * 0.025)) | 0;

      // Turbulenz für organisches Gefühl
      const t = state.turb | 0;
      if (t > 0 && (tick & 7) === 0) {
        vx += (irand(2*t+1)-t) * 4;
        vy += (irand(2*t+1)-t) * 4;
      }

      vxNext[i] = clamp(vx, -24000, 24000);
      vyNext[i] = clamp(vy, -24000, 24000);

      // Druck-Relaxation (Energie-Dissipation)
      const relax = 0.982 + (damp - 0.80) * 0.035;
      pField[i] = (p * relax) | 0;
    }
  }

  // ===== PHASE 3: VELOCITY DIFFUSION =====
  // Wind breitet sich zu Nachbarzellen aus (verhindert "Laser-Linie")
  const vDiff = 0.28;  // Erhöht für bessere Ausbreitung
  for (let ay=0; ay<aH; ay++) {
    const row = ay*aW;
    for (let ax=0; ax<aW; ax++) {
      const i = row + ax;
      const vx = vxNext[i];
      const vy = vyNext[i];

      let svx = 0, svy = 0, cnt = 0;
      if (ax>0) { svx += vxNext[i-1]; svy += vyNext[i-1]; cnt++; }
      if (ax<aW-1) { svx += vxNext[i+1]; svy += vyNext[i+1]; cnt++; }
      if (ay>0) { svx += vxNext[i-aW]; svy += vyNext[i-aW]; cnt++; }
      if (ay<aH-1) { svx += vxNext[i+aW]; svy += vyNext[i+aW]; cnt++; }
      const avx = cnt ? (svx/cnt) : vx;
      const avy = cnt ? (svy/cnt) : vy;

      // Mischen: aktueller Wert + Nachbar-Durchschnitt
      vxField[i] = clamp((vx * (1-vDiff) + avx * vDiff) | 0, -24000, 24000);
      vyField[i] = clamp((vy * (1-vDiff) + avy * vDiff) | 0, -24000, 24000);
    }
  }

  // ===== PHASE 4: ADVECTION - Wind trägt sich selbst =====
  // Das macht Wind "lebendig" - er bewegt sich übers Feld
  // Semi-Lagrangian: schaue zurück entlang des Velocity-Vektors
  for (let i=0; i<vxField.length; i++) { vxNext[i] = vxField[i]; vyNext[i] = vyField[i]; }

  const advStrength = 1.5;  // ERHÖHT: stärkere Selbst-Advektion
  const advBlend = 0.62;    // ERHÖHT: mehr advektierte Velocity übernehmen

  for (let ay=0; ay<aH; ay++) {
    for (let ax=0; ax<aW; ax++) {
      const i = aidx(ax,ay);
      const vx = vxNext[i];
      const vy = vyNext[i];

      // Schau zurück entlang des Velocity-Vektors
      const backX = clamp(ax - (vx/18000)*advStrength, 0, aW-1);
      const backY = clamp(ay - (vy/18000)*advStrength, 0, aH-1);

      // Bilineare Interpolation für glatte Advektion
      const bx0 = Math.floor(backX);
      const by0 = Math.floor(backY);
      const bx1 = Math.min(bx0 + 1, aW - 1);
      const by1 = Math.min(by0 + 1, aH - 1);
      const fx = backX - bx0;
      const fy = backY - by0;

      const i00 = aidx(bx0, by0);
      const i10 = aidx(bx1, by0);
      const i01 = aidx(bx0, by1);
      const i11 = aidx(bx1, by1);

      // Interpoliere vx
      const vx00 = vxNext[i00], vx10 = vxNext[i10];
      const vx01 = vxNext[i01], vx11 = vxNext[i11];
      const vxTop = vx00 * (1-fx) + vx10 * fx;
      const vxBot = vx01 * (1-fx) + vx11 * fx;
      const advVX = vxTop * (1-fy) + vxBot * fy;

      // Interpoliere vy
      const vy00 = vyNext[i00], vy10 = vyNext[i10];
      const vy01 = vyNext[i01], vy11 = vyNext[i11];
      const vyTop = vy00 * (1-fx) + vy10 * fx;
      const vyBot = vy01 * (1-fx) + vy11 * fx;
      const advVY = vyTop * (1-fy) + vyBot * fy;

      // Mische advektierte Velocity mit aktueller
      vxField[i] = clamp(((vxField[i] * (1-advBlend)) + (advVX * advBlend)) * velocityDecay | 0, -24000, 24000);
      vyField[i] = clamp(((vyField[i] * (1-advBlend)) + (advVY * advBlend)) * velocityDecay | 0, -24000, 24000);
    }
  }

  // ===== PHASE 5: DIVERGENCE → PRESSURE =====
  // Hält den Flow inkompressibel (fluid-ähnliches Verhalten)
  const divK = 0.28;
  for (let ay=0; ay<aH; ay++) {
    for (let ax=0; ax<aW; ax++) {
      const i = aidx(ax,ay);
      const vl = ax>0 ? vxField[i-1] : vxField[i];
      const vr = ax<aW-1 ? vxField[i+1] : vxField[i];
      const vu = ay>0 ? vyField[i-aW] : vyField[i];
      const vd = ay<aH-1 ? vyField[i+aW] : vyField[i];
      const div = (vr - vl + vd - vu) * divK;
      if (div !== 0) pField[i] = clamp(pField[i] - div, -30000, 30000);
    }
  }

  // ===== PHASE 6: HINDERNISSE - Prallen, Umleiten, Schatten =====

  // Dominante Windrichtung bestimmen (für Lee-Zone Berechnung)
  let dominantVX = globalVX, dominantVY = globalVY;
  let totalVX = 0, totalVY = 0, sampleCount = 0;
  for (let i = 0; i < vxField.length; i += 5) {
    totalVX += vxField[i];
    totalVY += vyField[i];
    sampleCount++;
  }
  if (sampleCount > 0) {
    const avgVX = totalVX / sampleCount;
    const avgVY = totalVY / sampleCount;
    if (Math.abs(avgVX) + Math.abs(avgVY) > Math.abs(dominantVX) + Math.abs(dominantVY)) {
      dominantVX = avgVX;
      dominantVY = avgVY;
    }
  }

  const gMag = Math.hypot(dominantVX, dominantVY);
  const wdx = gMag > 250 ? (dominantVX < 0 ? -1 : (dominantVX > 0 ? 1 : 0)) : 0;
  const wdy = gMag > 250 ? (dominantVY < 0 ? -1 : (dominantVY > 0 ? 1 : 0)) : 0;

  for (let ay=0; ay<aH; ay++) {
    const row = ay*aW;
    for (let ax=0; ax<aW; ax++) {
      const i = row + ax;
      const sol = solidField[i];

      if (sol > 0) {
        // ===== HINDERNIS GETROFFEN =====
        // Wind prallt: reduziert Velocity, erhöht Druck, leitet um
        const blockFactor = 1 - 0.35 * sol; // VERSTÄRKT: stärkeres Blockieren
        const oldVX = vxField[i];
        const oldVY = vyField[i];

        // Velocity am Hindernis reduzieren
        vxField[i] = (oldVX * blockFactor) | 0;
        vyField[i] = (oldVY * blockFactor) | 0;

        // Druck staut sich vor Hindernissen
        pField[i] = clamp(pField[i] + (sol * 280), -30000, 30000);

        // ===== WIND UMLEITEN =====
        // Blockierte Energie wird zur Seite gedrückt (Flow um Hindernisse)
        const blockedEnergy = (Math.abs(oldVX) + Math.abs(oldVY)) * 0.45 * sol; // VERSTÄRKT

        // Finde Richtung zum Umleiten (senkrecht zum Wind)
        const magXY = Math.abs(oldVX) + Math.abs(oldVY) + 1;
        const normX = oldVX / magXY;
        const normY = oldVY / magXY;

        // Umleitung in senkrechte Richtungen
        if (Math.abs(oldVX) > Math.abs(oldVY)) {
          // Horizontaler Wind → vertikal umleiten
          if (ay > 0) {
            vyField[i-aW] = clamp(vyField[i-aW] - blockedEnergy * 0.6 | 0, -24000, 24000);
            // Auch etwas horizontale Weiterleitung
            vxField[i-aW] = clamp(vxField[i-aW] + (normX * blockedEnergy * 0.3)|0, -24000, 24000);
          }
          if (ay < aH-1) {
            vyField[i+aW] = clamp(vyField[i+aW] + blockedEnergy * 0.6 | 0, -24000, 24000);
            vxField[i+aW] = clamp(vxField[i+aW] + (normX * blockedEnergy * 0.3)|0, -24000, 24000);
          }
        } else {
          // Vertikaler Wind → horizontal umleiten
          if (ax > 0) {
            vxField[i-1] = clamp(vxField[i-1] - blockedEnergy * 0.6 | 0, -24000, 24000);
            vyField[i-1] = clamp(vyField[i-1] + (normY * blockedEnergy * 0.3)|0, -24000, 24000);
          }
          if (ax < aW-1) {
            vxField[i+1] = clamp(vxField[i+1] + blockedEnergy * 0.6 | 0, -24000, 24000);
            vyField[i+1] = clamp(vyField[i+1] + (normY * blockedEnergy * 0.3)|0, -24000, 24000);
          }
        }
        continue;
      }

      // ===== LEE-ZONE (Windschatten) =====
      // Bereiche hinter Hindernissen bekommen weniger Wind
      if (wdx !== 0 || wdy !== 0) {
        let shadowStrength = 0;
        let shadowDist = 0;

        // Prüfe mehrere Zellen windaufwärts
        for (let dist = 1; dist <= 4; dist++) { // ERHÖHT: längerer Schatten
          const ux = ax - wdx * dist;
          const uy = ay - wdy * dist;
          if (ux >= 0 && uy >= 0 && ux < aW && uy < aH) {
            const upwindSol = solidField[aidx(ux,uy)];
            if (upwindSol > 0) {
              // Schatten wird schwächer mit Distanz
              const strength = upwindSol * (1 - (dist-1) * 0.22);
              if (strength > shadowStrength) {
                shadowStrength = strength;
                shadowDist = dist;
              }
            }
          }
        }

        if (shadowStrength > 0) {
          // Lee-Zone: reduzierter Wind
          const leeFactor = 1 - 0.55 * shadowStrength; // VERSTÄRKT
          vxField[i] = (vxField[i] * leeFactor) | 0;
          vyField[i] = (vyField[i] * leeFactor) | 0;

          // Negativer Druck in der Lee-Zone (Sog)
          pField[i] = clamp(pField[i] - (shadowStrength * 120)|0, -30000, 30000);

          // Wirbelbildung in der Lee-Zone (bei starkem Wind)
          if (gMag > 3000 && shadowDist === 2 && rnd() < 0.15) {
            // Kleine Wirbel hinter Hindernissen
            const vortexStr = shadowStrength * 400;
            const vortexDir = (tick + ax + ay) & 1 ? 1 : -1;
            if (Math.abs(wdx) > Math.abs(wdy)) {
              vyField[i] = clamp(vyField[i] + vortexDir * vortexStr | 0, -24000, 24000);
            } else {
              vxField[i] = clamp(vxField[i] + vortexDir * vortexStr | 0, -24000, 24000);
            }
          }
        }
      }

      // ===== VENTURI-EFFEKT =====
      // Enge Kanäle beschleunigen den Flow
      const left = ax>0 ? solidField[i-1] : 0;
      const right = ax<aW-1 ? solidField[i+1] : 0;
      const up = ay>0 ? solidField[i-aW] : 0;
      const down = ay<aH-1 ? solidField[i+aW] : 0;

      // Horizontaler Kanal (oben und unten Wände)
      if (up > 0 && down > 0 && left === 0 && right === 0) {
        vxField[i] = clamp((vxField[i] * 1.22) | 0, -24000, 24000); // VERSTÄRKT
      }
      // Vertikaler Kanal (links und rechts Wände)
      if (left > 0 && right > 0 && up === 0 && down === 0) {
        vyField[i] = clamp((vyField[i] * 1.22) | 0, -24000, 24000);
      }
    }
  }
}

function updateEntities(){
  for (const e of entities) {
    e.t++;
    e.lastX = e.x|0;
    e.lastY = e.y|0;

    if (e.kind === 'bird') {
      // Birds: floaty, strongly affected by wind
      const gx = clamp(e.x|0, 0, W-1);
      const gy = clamp(e.y|0, 0, H-1);
      const ax = sampleAirVX(gx,gy) / 18000;
      const ay = sampleAirVY(gx,gy) / 18000;
      e.vx += ax * 0.7;
      e.vy += ay * 0.7;

      // self propulsion
      e.vx += (rnd()-0.5) * 0.10;
      e.vy += (rnd()-0.5) * 0.06;

      // keep altitude
      if (e.y > H-60) e.vy -= 0.35;
      if (e.y < 20) e.vy += 0.20;

      // avoid solids
      const ct = typeA[idx(gx,gy)];
      if (!isEmptyCell(ct) && ct !== E.FIRE) e.vy -= 0.6;

      // clamp speed
      e.vx = clamp(e.vx, -1.8, 1.8);
      e.vy = clamp(e.vy, -1.2, 1.2);

      e.x = clamp(e.x + e.vx, 2, W-3);
      e.y = clamp(e.y + e.vy, 2, H-3);
    } else if (e.kind === 'human') {
      const gx = clamp(e.x|0, 0, W-1);
      const gy = clamp(e.y|0, 0, H-1);

      // wind drift small
      e.vx += (sampleAirVX(gx,gy) / 24000) * 0.06;

      // gravity
      e.vy += 0.22;

      // danger: run from fire/lava
      const danger = hasNeighborOfType(gx,gy,E.FIRE) || hasNeighborOfType(gx,gy,E.LAVA);
      if (danger) {
        e.dir = (rnd()<0.5) ? -1 : 1;
        e.vx += e.dir * 0.25;
      }

      // ground check at feet
      const footY = clamp((e.y + 5)|0, 0, H-1);
      const belowY = clamp(footY+1, 0, H-1);
      const belowT = typeA[idx(gx, belowY)];
      const onGround = !isEmptyCell(belowT) && belowT !== E.FIRE && belowT !== E.SMOKE && belowT !== E.STEAM;

      if (onGround) {
        // friction and walking
        e.vy = Math.min(e.vy, 0);
        if ((e.t & 31) === 0) {
          e.dir = rnd()<0.5 ? -1 : 1;
        }
        e.vx += e.dir * 0.08;
      }

      // clamp speeds
      e.vx = clamp(e.vx, -1.1, 1.1);
      e.vy = clamp(e.vy, -2.5, 2.8);

      // attempt move x
      const nx = clamp(e.x + e.vx, 2, W-3);
      const nxCell = clamp(nx|0, 0, W-1);
      const waistY = clamp((e.y|0), 0, H-1);
      const hit = !isEmptyCell(typeA[idx(nxCell, waistY)]) && typeA[idx(nxCell, waistY)] !== E.SMOKE && typeA[idx(nxCell, waistY)] !== E.STEAM;
      if (hit) {
        e.vx *= -0.3;
        e.dir *= -1;
      } else {
        e.x = nx;
      }

      // attempt move y
      const ny = clamp(e.y + e.vy, 2, H-3);
      const nyCell = clamp(ny|0, 0, H-1);
      const hitY = !isEmptyCell(typeA[idx(gx, nyCell)]) && typeA[idx(gx, nyCell)] !== E.SMOKE && typeA[idx(gx, nyCell)] !== E.STEAM;
      if (hitY) {
        // stop falling
        e.vy = 0;
      } else {
        e.y = ny;
      }
    }

    // mark dirty for render
    if ((e.x|0)!==e.lastX || (e.y|0)!==e.lastY) {
      markEntityDirty(e, true);
    }
  }
}

function updatePowdersAndFluids(){
  // bottom-up
  for (let cy = cH-1; cy >= 0; cy--) {
    const y0 = cy*CHUNK;
    const y1 = Math.min(H-1, y0+CHUNK-1);
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx,cy);
      if (!cActive[ci]) continue;
      // reset changed marker each tick, will be set by swaps
      // (we keep it if already set by earlier stages)

      // alternate x direction per row for less bias
      for (let y = y1; y >= y0; y--) {
        const dir = (y & 1) ? 1 : -1;
        let xStart = dir===1 ? cx*CHUNK : Math.min(W-1, cx*CHUNK+CHUNK-1);
        let xEnd = dir===1 ? Math.min(W, cx*CHUNK+CHUNK) : (cx*CHUNK - 1);
        for (let x = xStart; x !== xEnd; x += dir) {
          const i = idx(x,y);
          const t = typeA[i];
          if (IS_POWDER[t]) {
            // slow dirt/ash a bit
            if (t===E.DIRT && (tick & 3) !== 0) continue;
            if (t===E.ASH && (tick & 1) !== 0) continue;
            powderStep(x,y,t);
          } else if (IS_FLUID[t]) {
            fluidStep(x,y,t);
          }
        }
      }
    }
  }
}

function updateGases(){
  // top-down
  for (let cy=0; cy<cH; cy++) {
    const y0 = cy*CHUNK;
    const y1 = Math.min(H-1, y0+CHUNK-1);
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx,cy);
      if (!cActive[ci]) continue;
      for (let y=y0; y<=y1; y++) {
        const dir = (y & 1) ? 1 : -1;
        let xStart = dir===1 ? cx*CHUNK : Math.min(W-1, cx*CHUNK+CHUNK-1);
        let xEnd = dir===1 ? Math.min(W, cx*CHUNK+CHUNK) : (cx*CHUNK - 1);
        for (let x=xStart; x!==xEnd; x+=dir) {
          const t = typeA[idx(x,y)];
          if (t===E.SMOKE || t===E.STEAM || t===E.SPARK || t===E.CLOUD || t===E.GAS || t===E.FOAM || t===E.LASER) {
            gasStep(x,y,t);
          }
        }
      }
    }
  }
}

function updateFireAndLife(){
  // scan active chunks only
  for (let cy=0; cy<cH; cy++) {
    const y0 = cy*CHUNK;
    const y1 = Math.min(H-1, y0+CHUNK-1);
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx,cy);
      if (!cActive[ci]) continue;
      for (let y=y0; y<=y1; y++) {
        const x0 = cx*CHUNK;
        const x1 = Math.min(W-1, x0+CHUNK-1);
        for (let x=x0; x<=x1; x++) {
          const t = typeA[idx(x,y)];
          if (t===E.FIRE || t===E.DIRT || t===E.SEED || t===E.SPROUT || t===E.PLANT || t===E.LAVA || t===E.ICE || t===E.METAL || t===E.VINE) {
            fireAndLifeCell(x,y);
          }
        }
      }
    }
  }
}

function sleepChunks(){
  // if a chunk wasn't changed for some time, sleep it
  for (let cy=0; cy<cH; cy++) {
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx,cy);
      if (!cActive[ci]) continue;
      if (cChanged[ci]) {
        cSleep[ci] = 0;
      } else {
        cSleep[ci]++;
        if (cSleep[ci] > 70) {
          cActive[ci] = 0;
        }
      }
      cChanged[ci] = 0;
    }
  }
}

// --- Rendering ---
function blend(a,b,t){
  const ar = a & 255, ag=(a>>>8)&255, ab=(a>>>16)&255, aa=(a>>>24)&255;
  const br = b & 255, bg=(b>>>8)&255, bb=(b>>>16)&255, ba=(b>>>24)&255;
  const r = (ar + (br-ar)*t)|0;
  const g = (ag + (bg-ag)*t)|0;
  const bl = (ab + (bb-ab)*t)|0;
  const al = (aa + (ba-aa)*t)|0;
  return (al<<24) | (bl<<16) | (g<<8) | r;
}

function updatePixelsForChunk(cx,cy){
  const x0 = cx*CHUNK;
  const y0 = cy*CHUNK;
  const x1 = Math.min(W-1, x0+CHUNK-1);
  const y1 = Math.min(H-1, y0+CHUNK-1);
  for (let y=y0; y<=y1; y++) {
    let row = y*W;
    for (let x=x0; x<=x1; x++) {
      const i = row + x;
      const t = typeA[i];
      let col = PALETTE[t];

      // visual variations
      if (t===E.DIRT) {
        const m = dataA[i];
        const wet = clamp(m/255, 0, 1);
        col = blend(col, 0xff3b2418, wet*0.55);
      }
      if (t===E.MUD) {
        const m = dataA[i];
        const wet = clamp(m/255, 0, 1);
        col = blend(col, 0xff2a201a, wet*0.35);
      }
      // ===== WET SAND VISUALISIERUNG =====
      if (t===E.SAND) {
        const wetness = dataA[i] | 0;
        if (wetness > 0) {
          // Nasser Sand: dunkler, gesättigter
          const wetFactor = clamp(wetness / 200, 0, 1);
          col = blend(col, 0xff5a6880, wetFactor * 0.45);  // Dunkler, grauer
        }
      }
      // ===== KEIMENDER SAMEN VISUALISIERUNG =====
      if (t===E.SEED) {
        const rawData = dataA[i] | 0;
        const age = rawData & 0x7F;
        const germinating = (rawData >> 7) & 1;

        if (germinating) {
          // Keimend: wird grünlicher, zeigt "ich arbeite"
          const progress = clamp(age / 40, 0, 1);
          col = blend(col, 0xff4aaa60, progress * 0.5);
          // Leichtes Pulsieren
          if ((tick & 15) < 8) {
            col = blend(col, 0xff60c070, 0.15);
          }
        } else if (age === 0 && rawData > 0) {
          // Absterbender Samen: dunkler
          col = blend(col, 0xff404040, 0.4);
        }
      }
      // ===== LAVA VISUALISIERUNG (Kruste + Hitze) =====
      if (t===E.LAVA) {
        const rawData = dataA[i] | 0;
        const heat = rawData & 0x7F;
        const crusted = (rawData >> 7) & 1;

        if (crusted) {
          // Kruste: dunkler, grauer
          col = blend(col, 0xff303030, 0.55);
          // Gelegentliches Glühen durch Risse
          if (heat > 70 && rnd() < 0.1) {
            col = blend(col, 0xff4020ff, 0.4);
          }
        } else {
          // Heiße Lava: heller bei mehr Hitze
          const heatFactor = clamp(heat / 100, 0, 1);
          col = blend(col, 0xff50eeff, heatFactor * 0.5);
          // Flackern
          if (rnd() < 0.2) col = blend(col, 0xff80d0ff, 0.3);
        }
      }
      if (t===E.WATER) {
        // baseline shimmer
        if ((tick & 31)===0 && rnd()<0.02) col = blend(col, 0xffbdf3ff, 0.35);

        // colder water tint (supercooled looks brighter)
        const wt = dataA[i] | 0;
        if (wt < 110) {
          const cold = clamp((110 - wt) / 60, 0, 1);
          col = blend(col, 0xffcfeaff, 0.35 * cold);
        }

        // wind-driven surface "waves" (purely visual, cheap, makes it feel alive)
        if (y > 0) {
          const aboveT = typeA[idx(x, y-1)];
          if (aboveT === E.AIR || aboveT === E.SMOKE || aboveT === E.STEAM) {
            const vx = sampleAirVX(x,y);
            const vy = sampleAirVY(x,y);
            const mag = Math.abs(vx) + Math.abs(vy);
            const chop = clamp(mag / 18000, 0, 1);
            if (chop > 0.05) {
              const pat = ((x * 13 + tick * 5) & 31) / 31;
              if (pat < chop * 0.22) {
                col = blend(col, 0xffe8fbff, 0.55 * chop);
              }
              // occasional whitecap pixel just above the water (only if within this chunk)
              if (aboveT === E.AIR && (y-1) >= y0) {
                const pat2 = ((x * 29 + tick * 7) & 63) / 63;
                if (pat2 < chop * 0.10) {
                  const ai = idx(x, y-1);
                  const foam =  (150<<24) | (255<<16) | (255<<8) | 255;
                  pix32[ai] = blend(pix32[ai], foam, 0.70 * chop);
                }
              }
            }
          }
        }
      }
      if (t===E.FIRE) {
        col = blend(col, 0xffffff8a, 0.25 + rnd()*0.45);
        if (rnd() < 0.25) col = blend(col, 0xffffa640, 0.35);
      }
      if (t===E.SMOKE) {
        if (rnd()<0.03) col = blend(col, 0xffc8c8d2, 0.25);
      }
      if (t===E.STEAM) {
        if (rnd()<0.04) col = blend(col, 0xffffffff, 0.20);
      }
      if (t===E.SPARK) {
        // Firework sparks can have different colors based on upper data bits
        const colorBits = (dataA[i] >> 6) & 3;
        if (colorBits === 1) col = blend(col, 0xff5050ff, 0.6); // Blue
        else if (colorBits === 2) col = blend(col, 0xff50ff50, 0.6); // Green
        else if (colorBits === 3) col = blend(col, 0xffff50ff, 0.6); // Magenta
        col = blend(col, 0xffffffff, rnd()*0.55);
      }
      if (t===E.CLOUD) {
        // dataA: bits 0-6 = waterContent, bit 7 = charged
        const rawData = dataA[i] | 0;
        const waterContent = rawData & 0x7F;
        const charged = (rawData >> 7) & 1;

        // Dunklere Wolken bei mehr Wasser
        const dark = clamp(waterContent / 100, 0, 1);
        col = blend(col, 0xff5a6478, 0.55 * dark);

        // Geladene Wolken: gelegentliches Aufblitzen
        if (charged) {
          col = blend(col, 0xff4a5060, 0.25);
          // Interne Blitze (leuchten)
          if (rnd() < 0.03) {
            col = blend(col, 0xffffffff, 0.5);
          }
        }
      }
      if (t===E.PLANT || t===E.SPROUT) {
        const age = dataA[i];
        col = blend(col, 0xff26ff7a, clamp(age/180,0,1)*0.25);
      }
      // === NEW ELEMENT VISUALS ===
      if (t===E.ACID) {
        // Bubbling acid - slight color variation
        if (rnd() < 0.06) col = blend(col, 0xff40ff40, 0.4);
        if (rnd() < 0.03) col = blend(col, 0xffffffff, 0.25);
      }
      if (t===E.SOAP) {
        // Iridescent shimmer
        if (rnd() < 0.08) col = blend(col, 0xffffb0e0, 0.35);
        if (rnd() < 0.04) col = blend(col, 0xffb0e0ff, 0.30);
      }
      if (t===E.GAS) {
        // Nearly invisible, slight shimmer
        col = blend(col, 0xff608060, 0.15 + rnd()*0.1);
      }
      if (t===E.NITRO) {
        // Unstable glow based on instability
        const unstable = dataA[i] / 255;
        col = blend(col, 0xff4040ff, unstable * 0.4);
        if (rnd() < 0.05) col = blend(col, 0xffffffff, 0.3);
      }
      if (t===E.FIREWORK) {
        // Fuse sparkle
        const fuse = dataA[i] / 180;
        col = blend(col, 0xffffa060, (1-fuse) * 0.5);
        if (rnd() < 0.1) col = blend(col, 0xffffffff, 0.5);
      }
      if (t===E.VINE) {
        const age = dataA[i];
        col = blend(col, 0xff30a050, clamp(age/100,0,1)*0.3);
        // Leaf highlights
        if (rnd() < 0.04) col = blend(col, 0xff60ff80, 0.35);
      }
      if (t===E.ANT) {
        // Tiny legs animation hint
        if ((tick + x*3) & 7 === 0) col = blend(col, 0xff503020, 0.3);
      }
      if (t===E.METAL) {
        // Metallic sheen
        if (rnd() < 0.02) col = blend(col, 0xffffffff, 0.25);
        // Slight rust tint if rusting
        const rust = dataA[i];
        if (rust > 0) col = blend(col, 0xff5040a0, rust/255 * 0.4);
      }
      if (t===E.RUST) {
        // Crumbly texture
        if (rnd() < 0.05) col = blend(col, 0xff402820, 0.35);
      }
      if (t===E.FOAM) {
        // Bubble highlights
        if (rnd() < 0.15) col = blend(col, 0xffffffff, 0.5);
        col = blend(col, 0xfff0f8ff, 0.2);
      }
      if (t===E.LASER) {
        // Bright laser beam
        col = blend(col, 0xffffffff, 0.6 + rnd()*0.3);
        // Core glow
        if (rnd() < 0.3) col = blend(col, 0xff8080ff, 0.4);
      }
      if (t===E.LIGHTNING) {
        col = blend(col, 0xffffffff, 0.8);
      }

      pix32[i] = col;
    }
  }
}

function speedColor(v){
  const s = clamp((v/22000), 0, 1);
  if (s < 0.25) return blend(0xff1b2a7a, 0xff2fd1ff, s/0.25);
  if (s < 0.50) return blend(0xff2fd1ff, 0xff3ae36b, (s-0.25)/0.25);
  if (s < 0.75) return blend(0xff3ae36b, 0xffffd84a, (s-0.50)/0.25);
  return blend(0xffffd84a, 0xffff3a2a, (s-0.75)/0.25);
}

function drawWindHeatmap(){
  // ===== FARB-OVERLAY NUR WO WIND IST =====
  // Nicht ganzer Screen rot - nur Zellen mit speed > threshold
  ctx.save();
  const threshold = 2500;  // Minimum wind speed to show

  for (let ay=0; ay<aH; ay++) {
    for (let ax=0; ax<aW; ax++) {
      const i = aidx(ax,ay);
      const vx = (vxField[i] + (ambVX|0) + (globalVX|0))|0;
      const vy = (vyField[i] + (ambVY|0) + (globalVY|0))|0;
      const mag = Math.abs(vx) + Math.abs(vy);

      // Skip cells with no significant wind
      if (mag < threshold) continue;

      // Alpha wächst mit Stärke (schwach = kaum sichtbar)
      const alpha = clamp((mag - threshold) / 18000, 0.12, 0.55);

      const col = speedColor(mag);
      const r = col & 255, g = (col>>>8)&255, b=(col>>>16)&255;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fillRect(ax*AIR_SCALE, ay*AIR_SCALE, AIR_SCALE, AIR_SCALE);
    }
  }
  ctx.restore();
}

function drawWindOverlay(color){
  ctx.save();
  const step = AIR_SCALE;
  for (let ay=0; ay<aH; ay++) {
    for (let ax=0; ax<aW; ax++) {
      const i = aidx(ax,ay);
      const vx = (vxField[i] + (ambVX|0) + (globalVX|0))|0;
      const vy = (vyField[i] + (ambVY|0) + (globalVY|0))|0;
      const mag = Math.abs(vx) + Math.abs(vy);
      if (mag < 3500) continue;
      const alpha = clamp(mag / 22000, 0.08, 0.40);
      if (color) {
        const col = speedColor(mag);
        const r = col & 255, g = (col>>>8)&255, b=(col>>>16)&255;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      } else {
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      }
      ctx.fillRect(ax*step, ay*step, step, step);
    }
  }
  ctx.restore();
}

function drawVectors(){
  // ===== PFEILE DIE LEBENDIG WIRKEN =====
  // Nur wo Wind ist, "atmen" mit Jitter, dynamische Dichte
  ctx.save();

  const threshold = 2000;  // Minimum wind to show arrow
  const baseStep = AIR_SCALE * 3;  // Base grid spacing

  for (let ay=0; ay<aH; ay+=1) {
    for (let ax=0; ax<aW; ax+=1) {
      const i = aidx(ax,ay);
      const vx = (vxField[i] + (ambVX|0) + (globalVX|0))|0;
      const vy = (vyField[i] + (ambVY|0) + (globalVY|0))|0;
      const mag = Math.hypot(vx, vy);

      // Skip cells with no significant wind
      if (mag < threshold) continue;

      // Dynamische Dichte: bei starker Strömung mehr Pfeile
      // Bei schwacher Strömung: nur jeden 2. oder 3. Pfeil zeigen
      const densitySkip = mag < 5000 ? 3 : (mag < 10000 ? 2 : 1);
      if ((ax + ay) % densitySkip !== 0) continue;

      const x = ax * AIR_SCALE + AIR_SCALE/2;
      const y = ay * AIR_SCALE + AIR_SCALE/2;

      // Pfeil-Länge basierend auf Windstärke
      const len = clamp(mag / 2000, 2, 12);
      const nx = vx / (mag || 1);
      const ny = vy / (mag || 1);

      // ===== "ATMEN" - leichte Animation =====
      // Kleine Winkelvariation basierend auf tick + Position
      const breathPhase = Math.sin((tick * 0.08) + ax * 0.5 + ay * 0.3);
      const jitterAngle = breathPhase * 0.12;  // ~7 Grad max
      const ca = Math.cos(jitterAngle), sa = Math.sin(jitterAngle);
      const jnx = nx * ca - ny * sa;
      const jny = nx * sa + ny * ca;

      // Leichte Längenvariation (atmen)
      const breathLen = len * (1 + breathPhase * 0.08);

      const dx = jnx * breathLen;
      const dy = jny * breathLen;

      // Farbe basierend auf Stärke
      const alpha = clamp(mag / 15000, 0.35, 0.85);
      const col = speedColor(mag);
      const r = col & 255, g = (col>>>8)&255, b=(col>>>16)&255;

      // Pfeil-Linie
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = mag > 8000 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);

      // Pfeil-Spitze (kleines Dreieck)
      if (len > 3) {
        const headLen = 2.5;
        const headAngle = 0.5;  // ~28 Grad
        const hx1 = x + dx - headLen * (jnx * Math.cos(headAngle) - jny * Math.sin(headAngle));
        const hy1 = y + dy - headLen * (jnx * Math.sin(headAngle) + jny * Math.cos(headAngle));
        const hx2 = x + dx - headLen * (jnx * Math.cos(-headAngle) - jny * Math.sin(-headAngle));
        const hy2 = y + dy - headLen * (jnx * Math.sin(-headAngle) + jny * Math.cos(-headAngle));
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(hx1, hy1);
        ctx.moveTo(x + dx, y + dy);
        ctx.lineTo(hx2, hy2);
      }

      ctx.stroke();
    }
  }
  ctx.restore();
}

let tracerPhase = 0;
let tracerParticles = [];  // Persistent tracer particles
const MAX_TRACERS = 600;   // Reduced for performance

function drawTracers(){
  // ===== TRACER-PARTIKEL NUR WO WIND IST =====
  // Performance-optimiert: weniger Partikel, nur in Windgebieten
  ctx.save();

  const threshold = 2500;
  tracerPhase = (tracerPhase + 1) % 8;

  // Initialize tracers if needed
  if (tracerParticles.length === 0) {
    for (let n = 0; n < MAX_TRACERS; n++) {
      tracerParticles.push({
        x: rnd() * W,
        y: rnd() * H,
        age: irand(60)
      });
    }
  }

  // Update and draw tracers
  for (let i = 0; i < tracerParticles.length; i++) {
    const p = tracerParticles[i];
    const vx = sampleAirVX(p.x|0, p.y|0);
    const vy = sampleAirVY(p.x|0, p.y|0);
    const mag = Math.hypot(vx, vy);

    // Move particle with wind
    p.x += vx / 3500;
    p.y += vy / 3500;
    p.age++;

    // Respawn if out of bounds, too old, or in dead air
    const outOfBounds = p.x < 0 || p.x >= W || p.y < 0 || p.y >= H;
    const tooOld = p.age > 120;
    const noWind = mag < threshold && p.age > 30;

    if (outOfBounds || tooOld || noWind) {
      // Find a spot with wind for respawn
      let attempts = 0;
      do {
        p.x = rnd() * W;
        p.y = rnd() * H;
        const newVX = sampleAirVX(p.x|0, p.y|0);
        const newVY = sampleAirVY(p.x|0, p.y|0);
        if (Math.hypot(newVX, newVY) > threshold) break;
        attempts++;
      } while (attempts < 5);
      p.age = 0;
      continue;
    }

    // Only draw if in wind
    if (mag < threshold) continue;

    // Tracer appearance
    const alpha = clamp(mag / 12000, 0.25, 0.75) * (1 - p.age / 150);
    const size = mag > 8000 ? 2 : 1;

    // Color based on wind speed
    if (mag > 10000) {
      const col = speedColor(mag);
      const r = col & 255, g = (col>>>8)&255, b=(col>>>16)&255;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
    } else {
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    }

    // Draw tracer with small tail
    const dx = clamp(vx/4000, -3, 3);
    const dy = clamp(vy/4000, -3, 3);
    ctx.fillRect(p.x|0, p.y|0, size, size);
    // Tail (fainter)
    ctx.globalAlpha = alpha * 0.4;
    ctx.fillRect((p.x - dx)|0, (p.y - dy)|0, 1, 1);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function drawEntities(){
  for (const e of entities) {
    const sp = SPRITES[e.kind];
    const baseX = (e.x|0) - (sp.w>>1);
    const baseY = (e.y|0) - (sp.h>>1);
    for (let y=0; y<sp.h; y++) {
      const row = sp.rows[y];
      for (let x=0; x<sp.w; x++) {
        const ch = row[x];
        if (ch === '.') continue;
        const px = baseX + x;
        const py = baseY + y;
        if (!inb(px,py)) continue;
        ctx.fillStyle = SPRITE_COLORS[ch] || 'white';
        ctx.fillRect(px, py, 1, 1);
      }
    }

    // tiny "life" overlays (breathing, wing flutter hints) — render-only
    if (e.kind === 'human') {
      // breathing cycle: subtle chest pixel + little exhale puff sometimes
      const phase = (tick + e.id*23) % 90;
      const inhale = phase < 45;
      const chestX = baseX + 3;
      const chestY = baseY + 5;
      if (inb(chestX, chestY)) {
        ctx.fillStyle = inhale ? 'rgba(140,200,255,1)' : 'rgba(90,150,230,1)';
        ctx.fillRect(chestX, chestY, 1, 1);
      }

      // small exhale puff (only if there is "air" above head)
      if (phase >= 45 && phase < 55) {
        const puffX = baseX + 3 + ((phase - 45) >> 2);
        const puffY = baseY + 1 - ((phase - 45) >> 3);
        if (inb(puffX, puffY)) {
          const t0 = typeA[idx(puffX, puffY)];
          if (t0 === E.AIR || t0 === E.SMOKE || t0 === E.STEAM) {
            ctx.fillStyle = 'rgba(240,240,248,0.35)';
            ctx.fillRect(puffX, puffY, 1, 1);
            if (inb(puffX-1, puffY+1)) ctx.fillRect(puffX-1, puffY+1, 1, 1);
          }
        }
      }
    } else if (e.kind === 'bird') {
      // wing sparkle hint: tiny highlight occasionally
      if (((tick + e.id*19) & 31) === 0) {
        const hx = baseX + 3;
        const hy = baseY + 1;
        if (inb(hx, hy)) {
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.fillRect(hx, hy, 1, 1);
        }
      }
    }
  }
}

function render(){
  // Update pixels for dirty chunks
  for (let cy=0; cy<cH; cy++) {
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx,cy);
      if (!cDirty[ci]) continue;
      updatePixelsForChunk(cx,cy);
    }
  }

  if (state.visualize !== 0) {
    // In visualize mode, redraw full base each frame to avoid overlay trails
    ctx.putImageData(img, 0, 0);
  } else {
    // Fast path: only patch dirty rectangles
    for (let cy=0; cy<cH; cy++) {
      for (let cx=0; cx<cW; cx++) {
        const ci = cidx(cx,cy);
        if (!cDirty[ci]) continue;
        const x0 = cx*CHUNK;
        const y0 = cy*CHUNK;
        const w = Math.min(CHUNK, W - x0);
        const h = Math.min(CHUNK, H - y0);
        ctx.putImageData(img, 0, 0, x0, y0, w, h);
        cDirty[ci] = 0;
      }
    }
  }

  // overlays
  if (state.visualize === 1) drawWindHeatmap();
  else if (state.visualize === 2) drawVectors();
  else if (state.visualize === 3) drawTracers();
  else if (state.windOverlay) drawWindOverlay(!!state.windOverlayColor);

  drawEntities();
}

function kmhFromV(v){ return Math.round(Math.abs(v) * (120/24000)); }

function maybeSendHud(now){
  if (now - lastHudSend < 120) return;
  lastHudSend = now;

  const cx = clamp(cursorCell.x|0, 0, W-1);
  const cy = clamp(cursorCell.y|0, 0, H-1);
  const t = typeA[idx(cx,cy)];
  const ai = aidx(toAirX(cx), toAirY(cy));
  const vx = vxField[ai] | 0;
  const vy = vyField[ai] | 0;
  const p  = pField[ai] | 0;
  const kmh = Math.round(Math.hypot(kmhFromV(vx), kmhFromV(vy)));
  const gkmh = Math.round(Math.hypot(kmhFromV(globalVX|0), kmhFromV(globalVY|0)));
  const gang = Math.round((state.globalWindAngle||0) % 360);
  let extra = '';
  if (t===E.DIRT) extra = ` | Feuchte: ${dataA[idx(cx,cy)]}`;
  if (t===E.SEED || t===E.SPROUT || t===E.PLANT) extra = ` | Alter: ${dataA[idx(cx,cy)]}`;

  const text = `Tick ${tick}  |  Tool: ${state.tool}  |  Brush: ${state.brush}px  | Entities: ${entities.length}`;
  const text2 = `Cursor: (${cx},${cy})  |  Zelle: ${NAME_BY_ID[t] ?? t}${extra}  |  Wind: ~${kmh} km/h  |  Global: ${gkmh} km/h @ ${gang}°  |  Druck: ${p}`;
  postMessage({ type: 'hud', text, text2 });
}

// --- Main loop ---
let lastT = 0;
function step(tNow){
  if (!lastT) lastT = tNow;
  const dt = tNow - lastT;
  lastT = tNow;

  if (!paused) {
    tick++;

    // dynamic brush throttle based on frame time
    if (dt > 30) maxStrokesPerTick = 1;
    else if (dt > 22) maxStrokesPerTick = 2;
    else maxStrokesPerTick = 3;

    const strokes = Math.min(maxStrokesPerTick, paintQueue.length);
    for (let s=0; s<strokes; s++) {
      const entry = paintQueue.shift();
      if (!entry) break;
      paintAt(entry.from.x, entry.from.y, entry.to.x, entry.to.y, entry.state);
    }

    // staggered simulation (big perf win)
    updatePowdersAndFluids();
    if ((tick & 1) === 0) {
      updateGases();
      updateEntities();
      updateAir();
    }
    if ((tick & 3) === 0) {
      updateFireAndLife();
    }

    sleepChunks();
  }

  render();
  maybeSendHud(tNow);

  setTimeout(() => step(performance.now()), 0);
}

// --- Messages ---
onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    canvas = msg.canvas;
    W = msg.simW|0;
    H = msg.simH|0;
    DPR = msg.dpr || 1;
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    resizeCanvas();
    initBuffers();
    setTimeout(() => step(performance.now()), 0);
    return;
  }
  if (msg.type === 'resizeSim') {
    W = msg.simW|0;
    H = msg.simH|0;
    DPR = msg.dpr || 1;
    resizeCanvas();
    initBuffers();
    return;
  }
  if (msg.type === 'state') {
    state = { ...state, ...msg.state };
    return;
  }
  if (msg.type === 'stroke') {
    if (paintQueue.length < MAX_QUEUE) {
      paintQueue.push({ from: msg.from, to: msg.to, state: msg.state });
    }
    return;
  }
  // Wind hold tracking for hold-to-strengthen feature
  if (msg.type === 'windHoldStart') {
    windHoldStartTime = performance.now();
    windHoldActive = true;
    return;
  }
  if (msg.type === 'windHoldEnd') {
    windHoldActive = false;
    return;
  }
  if (msg.type === 'clear') {
    clearWorld(false);
    // mark all chunks dirty once
    for (let i=0; i<cDirty.length; i++) { cDirty[i]=1; cActive[i]=1; cChanged[i]=1; cSleep[i]=0; }
    return;
  }
  if (msg.type === 'togglePause') {
    paused = !paused;
    return;
  }
  if (msg.type === 'cursor') {
    cursorCell.x = clamp((msg.x*W)|0, 0, W-1);
    cursorCell.y = clamp((msg.y*H)|0, 0, H-1);
    return;
  }
};
