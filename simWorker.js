// simWorker.js (runs in a Web Worker)
import { E, PALETTE, DENSITY, IS_SOLID, IS_POWDER, IS_FLUID, IS_GAS, NAME_BY_ID } from './elements.js';

let canvas, ctx;
let W=640, H=360, DPR=1;

let typeA, dataA;
let paused = false;

// Coarse air grid (cheap but useful)
const AIR_SCALE = 4;
let aW, aH;
let pField, vxField, vyField; // Int16

// Rendering
let img, pix32;

// UI state
let state = {
  tool: 'paint',
  material: E.SAND,
  brush: 12,
  strength: 35,
  turb: 12,
  visualize: 0,
};

// Cursor sampling
let cursorCell = { x: 0, y: 0 };
let lastHudSend = 0;
const paintQueue = [];
const MAX_STROKES_PER_TICK = 2;
const MAX_PAINT_QUEUE = 200;

// RNG (fast, deterministic-ish)
let seed = 123456789;
function rnd() {
  seed = (seed * 1664525 + 1013904223) | 0;
  return (seed >>> 0) / 4294967296;
}
function irand(n) { return (rnd() * n) | 0; }

function idx(x,y){ return x + y*W; }
function inb(x,y){ return x>=0 && x<W && y>=0 && y<H; }

function aidx(ax,ay){ return ax + ay*aW; }
function toAirX(x){ return (x / AIR_SCALE) | 0; }
function toAirY(y){ return (y / AIR_SCALE) | 0; }

function clamp(v,lo,hi){ return v<lo?lo:(v>hi?hi:v); }

function clearWorld(){
  typeA.fill(E.AIR);
  dataA.fill(0);
  pField.fill(0);
  vxField.fill(0);
  vyField.fill(0);
}

function resizeCanvasToFit(){
  // Fit to device, keep simulation resolution fixed.
  // We scale the drawing to the visible canvas size.
  // Worker only knows the backing size; main canvas element handles CSS sizing.
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.imageSmoothingEnabled = false;
}

function initBuffers(){
  typeA = new Uint8Array(W*H);
  dataA = new Uint8Array(W*H);

  aW = Math.ceil(W / AIR_SCALE);
  aH = Math.ceil(H / AIR_SCALE);
  pField  = new Int16Array(aW*aH);
  vxField = new Int16Array(aW*aH);
  vyField = new Int16Array(aW*aH);

  img = ctx.createImageData(W, H);
  pix32 = new Uint32Array(img.data.buffer);

  clearWorld();

  // little seed scene
  // ground
  for (let y=H-40; y<H; y++) {
    for (let x=0; x<W; x++) {
      typeA[idx(x,y)] = (y>H-8) ? E.STONE : E.DIRT;
      dataA[idx(x,y)] = (y>H-20) ? 80 : 30; // moisture for dirt
    }
  }
}

// Tools
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

function drawLine(x0,y0,x1,y1, plot){
  // Bresenham
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
  // normalized 0..1
  const x0 = clamp((nx*W)|0, 0, W-1);
  const y0 = clamp((ny*H)|0, 0, H-1);
  const x1 = clamp((nx2*W)|0, 0, W-1);
  const y1 = clamp((ny2*H)|0, 0, H-1);

  // Direction for wind tool based on stroke vector
  const ddx = x1 - x0;
  const ddy = y1 - y0;
  let len = Math.hypot(ddx,ddy);
  if (len < 0.0001) len = 1;
  const dirx = ddx / len;
  const diry = ddy / len;
  st = { ...st, dirx, diry };

  const r = st.brush|0;
  const tool = st.tool;

  const stamp = (x,y) => {
    if (!inb(x,y)) return;

    if (tool === 'erase') {
      typeA[idx(x,y)] = E.AIR;
      dataA[idx(x,y)] = 0;
      return;
    }

    if (tool === 'paint') {
      const t = st.material|0;
      const i = idx(x,y);
      typeA[i] = t;
      // init state
      if (t===E.FIRE) dataA[i] = 40 + irand(50);
      else if (t===E.SMOKE) dataA[i] = 80 + irand(80);
      else if (t===E.DIRT) dataA[i] = 30; // moisture
      else if (t===E.SEED) dataA[i] = 0;
      else if (t===E.PLANT) dataA[i] = 10;
      else dataA[i] = 0;
      return;
    }

    // wind / pressure / temp act on air grid (or directly around the cell)
    const ax = toAirX(x);
    const ay = toAirY(y);
    const ai = aidx(ax,ay);

    if (tool === 'wind') {
      const s = st.strength|0;
      const turb = st.turb|0;
      const dx = st.dirx || 1;
      const dy = st.diry || 0;
      const jitter = (irand(2*turb+1) - turb);
      vxField[ai] = clamp(vxField[ai] + (dx*s*6 + jitter)|0, -32000, 32000);
      vyField[ai] = clamp(vyField[ai] + (dy*s*6 + jitter)|0, -32000, 32000);
      return;
    }

    if (tool === 'pressure') {
      const s = st.strength|0;
      pField[ai] = clamp(pField[ai] + (s*30)|0, -32000, 32000);
      return;
    }

    if (tool === 'temp') {
      // We don't simulate a full heat field for performance.
      // strength >0: ignite + melt ice; strength <0: freeze water.
      const s = st.strength|0;
      const i = idx(x,y);
      if (s > 0) {
        if (typeA[i]===E.WOOD || typeA[i]===E.PLANT || typeA[i]===E.OIL) {
          typeA[i]=E.FIRE; dataA[i]=40+irand(60);
        }
        if (typeA[i]===E.ICE) { typeA[i]=E.WATER; dataA[i]=0; }
        if (typeA[i]===E.WATER && rnd()<0.02) { typeA[i]=E.SMOKE; dataA[i]=120; }
      } else if (s < 0) {
        if (typeA[i]===E.WATER && rnd()<0.4) { typeA[i]=E.ICE; dataA[i]=0; }
        if (typeA[i]===E.LAVA && rnd()<0.15) { typeA[i]=E.STONE; dataA[i]=0; }
      }
      return;
    }
  };

  drawLine(x0,y0,x1,y1,(x,y)=>{
    applyBrushCircle(x,y,r,stamp);
  });
}

// Simulation core
function swap(i,j){
  const t = typeA[i]; typeA[i]=typeA[j]; typeA[j]=t;
  const d = dataA[i]; dataA[i]=dataA[j]; dataA[j]=d;
}

function isEmptyForMove(t){
  return t===E.AIR || t===E.SMOKE || t===E.FIRE || t===E.BIRD;
}

function tryMove(i, ni){
  const a = typeA[i];
  const b = typeA[ni];
  if (b === E.AIR || (DENSITY[b] < DENSITY[a] && b !== E.STONE && b !== E.WOOD && b !== E.ICE)) {
    swap(i,ni);
    return true;
  }
  return false;
}

function updatePowdersAndFluids(){
  // bottom-up pass for falling stuff
  for (let y=H-2; y>=0; y--) {
    const row = y*W;
    const dir = (y & 1) ? 1 : -1;
    let xStart = dir===1 ? 0 : W-1;
    let xEnd   = dir===1 ? W : -1;

    for (let x=xStart; x!==xEnd; x+=dir) {
      const i = row + x;
      const t = typeA[i];

      if (t===E.SAND || t===E.DIRT || t===E.SEED || t===E.ASH) {
        // powders
        // dirt moves a bit slower to look heavier/"sticky"
        if (t===E.DIRT && (seed & 3) !== 0) continue;
        if (t===E.ASH && (seed & 1) !== 0) continue;

        const below = i + W;
        if (below < W*H && tryMove(i, below)) continue;

        const dl = (x>0) ? (below-1) : -1;
        const dr = (x<W-1) ? (below+1) : -1;
        if (dl>=0 && dr>=0) {
          if (rnd()<0.5) { if (tryMove(i, dl)) continue; if (tryMove(i, dr)) continue; }
          else { if (tryMove(i, dr)) continue; if (tryMove(i, dl)) continue; }
        } else if (dl>=0) {
          tryMove(i, dl);
        } else if (dr>=0) {
          tryMove(i, dr);
        }
      }

      if (t===E.WATER || t===E.OIL || t===E.LAVA) {
        const visc = (t===E.LAVA) ? 3 : 1;
        if (visc>1 && (seed & visc) !== 0) continue;

        // fluids: down, then sideways
        const below = i + W;
        if (below < W*H && (typeA[below]===E.AIR || typeA[below]===E.SMOKE || (t===E.OIL && typeA[below]===E.WATER))) {
          swap(i, below);
          continue;
        }

        // try diagonals
        const dl = (x>0) ? (below-1) : -1;
        const dr = (x<W-1) ? (below+1) : -1;
        if (dl>=0 && (typeA[dl]===E.AIR || typeA[dl]===E.SMOKE)) { if (rnd()<0.5){ swap(i,dl); continue; } }
        if (dr>=0 && (typeA[dr]===E.AIR || typeA[dr]===E.SMOKE)) { swap(i,dr); continue; }

        // sideways flow
        const left  = (x>0) ? (i-1) : -1;
        const right = (x<W-1) ? (i+1) : -1;

        // oil prefers to sit on water
        if (t===E.OIL) {
          if (left>=0 && typeA[left]===E.AIR) { if (rnd()<0.5){ swap(i,left); continue; } }
          if (right>=0 && typeA[right]===E.AIR) { swap(i,right); continue; }
        } else {
          const bias = sampleAirBias(x,y);
          if (bias < 0) {
            if (left>=0 && (typeA[left]===E.AIR || typeA[left]===E.SMOKE)) { swap(i,left); continue; }
            if (right>=0 && (typeA[right]===E.AIR || typeA[right]===E.SMOKE)) { swap(i,right); continue; }
          } else {
            if (right>=0 && (typeA[right]===E.AIR || typeA[right]===E.SMOKE)) { swap(i,right); continue; }
            if (left>=0 && (typeA[left]===E.AIR || typeA[left]===E.SMOKE)) { swap(i,left); continue; }
          }
        }
      }

      if (t===E.HUMAN) {
        // simple dude: falls, then tries to walk randomly on ground.
        const below = i + W;
        if (below < W*H && isEmptyForMove(typeA[below])) { swap(i,below); continue; }

        // walk when standing
        if (rnd() < 0.35) {
          const dir2 = rnd() < 0.5 ? -1 : 1;
          const nx = x + dir2;
          if (nx>=0 && nx<W) {
            const ni = i + dir2;
            const nBelow = ni + W;
            if (typeA[ni]===E.AIR && (nBelow>=W*H || !isEmptyForMove(typeA[nBelow]))) {
              swap(i,ni);
            }
          }
        }
      }

      if (t===E.ICE) {
        // melt a bit near fire/lava
        if (hasNeighbor(i, E.FIRE) || hasNeighbor(i, E.LAVA)) {
          if (rnd() < 0.05) typeA[i] = E.WATER;
        }
      }

      if (t===E.LAVA) {
        // lava burns things and can turn water into smoke
        if (hasNeighbor(i, E.WATER)) {
          if (rnd() < 0.35) {
            // cool down -> stone
            typeA[i] = E.STONE;
          }
        }
        if (hasNeighbor(i, E.WOOD) || hasNeighbor(i, E.PLANT) || hasNeighbor(i, E.OIL)) {
          if (rnd() < 0.25) {
            // ignite neighbors
            igniteNeighbors(i);
          }
        }
      }
    }
  }
}

function updateGasesAndBirds(){
  // top-down pass for rising smoke, plus birds flying
  for (let y=1; y<H; y++) {
    const row = y*W;
    const dir = (y & 1) ? 1 : -1;
    let xStart = dir===1 ? 0 : W-1;
    let xEnd   = dir===1 ? W : -1;

    for (let x=xStart; x!==xEnd; x+=dir) {
      const i = row + x;
      const t = typeA[i];

      if (t===E.SMOKE) {
        let ttl = dataA[i];
        if (ttl>0) dataA[i] = ttl-1; else { typeA[i]=E.AIR; continue; }

        const ax = sampleAirVX(x,y);
        const sideways = ax < -600 ? -1 : (ax > 600 ? 1 : (rnd()<0.5?-1:1));

        const up = i - W;
        if (up>=0 && typeA[up]===E.AIR) { swap(i,up); continue; }
        const ul = (x>0) ? (up-1) : -1;
        const ur = (x<W-1) ? (up+1) : -1;
        if (sideways<0) {
          if (ul>=0 && typeA[ul]===E.AIR) { swap(i,ul); continue; }
          if (ur>=0 && typeA[ur]===E.AIR) { swap(i,ur); continue; }
        } else {
          if (ur>=0 && typeA[ur]===E.AIR) { swap(i,ur); continue; }
          if (ul>=0 && typeA[ul]===E.AIR) { swap(i,ul); continue; }
        }

        // drift sideways
        const ni = i + sideways;
        if (ni>=0 && ni<W*H && typeA[ni]===E.AIR) { swap(i,ni); }
      }

      if (t===E.BIRD) {
        // birds fly in air, follow wind a bit
        if (rnd() < 0.8) {
          const vx = sampleAirVX(x,y);
          const vy = sampleAirVY(x,y);
          let dx = vx < -500 ? -1 : (vx > 500 ? 1 : (rnd()<0.5?-1:1));
          let dy = vy < -500 ? -1 : (vy > 500 ? 1 : -1);

          // prefer staying above ground
          if (y>H-60) dy = -1;

          const nx = x + dx;
          const ny = y + dy;
          if (inb(nx,ny)) {
            const ni = idx(nx,ny);
            if (typeA[ni]===E.AIR || typeA[ni]===E.SMOKE) {
              swap(i,ni);
            }
          }
        }
      }
    }
  }
}

function updateFireAndLife(){
  // fire + seeds + plants + moisture cycling
  for (let y=0; y<H; y++) {
    const row = y*W;
    for (let x=0; x<W; x++) {
      const i = row + x;
      const t = typeA[i];

      if (t===E.FIRE) {
        let ttl = dataA[i];
        if (ttl>0) dataA[i] = ttl-1;
        else {
          typeA[i] = (rnd()<0.6) ? E.SMOKE : E.AIR;
          dataA[i] = (typeA[i]===E.SMOKE) ? 120+irand(80) : 0;
          continue;
        }

        // spread
        if (rnd() < 0.45) igniteNeighbors(i);

        // burn oil hard
        if (hasNeighbor(i, E.OIL) && rnd()<0.35) igniteNeighbors(i);

        // evaporate water locally
        if (hasNeighbor(i, E.WATER) && rnd()<0.22) {
          // turn some nearby water into smoke
          forEachNeighbor(i,(ni)=>{
            if (typeA[ni]===E.WATER && rnd()<0.3) { typeA[ni]=E.SMOKE; dataA[ni]=120; }
          });
        }

        // add local pressure (hot air)
        const ai = aidx(toAirX(x), toAirY(y));
        pField[ai] = clamp(pField[ai] + 120, -32000, 32000);
      }

      if (t===E.DIRT) {
        // moisture diffusion + evaporation near fire
        let m = dataA[i];
        if (m>0 && hasNeighbor(i, E.FIRE)) m = (m>2) ? (m-2) : 0;
        // get wet from water
        if (m<120 && hasNeighbor(i, E.WATER)) m = Math.min(200, m+2);
        // slow equalization
        if ((seed & 7) === 0) {
          let sum = 0, cnt = 0;
          forEachNeighbor(i,(ni)=>{
            if (typeA[ni]===E.DIRT) { sum += dataA[ni]; cnt++; }
          });
          if (cnt) {
            const avg = (sum / cnt) | 0;
            m += ((avg - m) * 0.08) | 0;
          }
        }
        dataA[i] = m;
      }

      if (t===E.SEED) {
        // seed can germinate if resting on dirt with moisture or water nearby
        if (y < H-1) {
          const below = i + W;
          if (typeA[below]===E.DIRT) {
            const moist = dataA[below];
            if (moist > 35 || hasNeighbor(i, E.WATER)) {
              // age up
              const age = dataA[i] + 1;
              dataA[i] = age;
              if (age > 25 && rnd()<0.25) {
                typeA[i] = E.PLANT;
                dataA[i] = 10;
              }
            }
          }
        }
      }

      if (t===E.PLANT) {
        // plant growth uses nearby dirt moisture
        let age = dataA[i];
        const moist = bestNeighborMoisture(i);
        if (moist > 25 || hasNeighbor(i, E.WATER)) {
          if (rnd() < 0.6) age = Math.min(250, age + 1);
          // slowly consume soil moisture
          if (y < H-1) {
            const below = i + W;
            if (typeA[below]===E.DIRT && dataA[below]>0 && rnd()<0.25) dataA[below]--;
          }
        }
        dataA[i] = age;

        // turn to wood trunk
        if (age > 90 && rnd()<0.02) {
          typeA[i] = E.WOOD;
          dataA[i] = 0;
        }

        // sprout upward
        if (age > 20 && rnd() < 0.08) {
          const up = i - W;
          if (up>=0 && typeA[up]===E.AIR) {
            typeA[up] = E.PLANT;
            dataA[up] = 10;
          }
        }

        // die if too dry
        if (moist < 8 && !hasNeighbor(i, E.WATER) && rnd()<0.01) {
          typeA[i] = E.ASH;
          dataA[i] = 0;
        }
      }

      if (t===E.WOOD) {
        // wood can rot to ash if soaked
        if (hasNeighbor(i, E.WATER) && rnd()<0.0008) {
          typeA[i] = E.ASH;
          dataA[i] = 0;
        }
      }

      if (t===E.OIL) {
        // oil ignites near fire
        if (hasNeighbor(i, E.FIRE) && rnd()<0.04) {
          typeA[i] = E.FIRE;
          dataA[i] = 60 + irand(80);
        }
      }

      if (t===E.WATER) {
        // freeze near lots of cold pressure (cheap hack)
        const ai = aidx(toAirX(x), toAirY(y));
        if (pField[ai] < -1500 && rnd()<0.003) typeA[i] = E.ICE;
      }

      if (t===E.ASH) {
        // ash can fertilize dirt
        if (y < H-1) {
          const below = i + W;
          if (typeA[below]===E.DIRT && dataA[below] < 200 && rnd()<0.02) dataA[below]++;
        }
      }

    }
  }
}

function igniteNeighbors(i){
  forEachNeighbor(i,(ni)=>{
    const t = typeA[ni];
    if (t===E.WOOD || t===E.PLANT || t===E.OIL || t===E.ASH) {
      if (rnd() < 0.22) {
        typeA[ni] = E.FIRE;
        dataA[ni] = 40 + irand(80);
      }
    }
  });
}

function forEachNeighbor(i, fn){
  const x = i % W;
  const y = (i / W) | 0;
  // 4-neighborhood for speed + stability
  if (x>0) fn(i-1);
  if (x<W-1) fn(i+1);
  if (y>0) fn(i-W);
  if (y<H-1) fn(i+W);
}

function hasNeighbor(i, tNeed){
  const x = i % W;
  const y = (i / W) | 0;
  if (x>0 && typeA[i-1]===tNeed) return true;
  if (x<W-1 && typeA[i+1]===tNeed) return true;
  if (y>0 && typeA[i-W]===tNeed) return true;
  if (y<H-1 && typeA[i+W]===tNeed) return true;
  return false;
}

function bestNeighborMoisture(i){
  let best = 0;
  forEachNeighbor(i,(ni)=>{
    if (typeA[ni]===E.DIRT) best = Math.max(best, dataA[ni]);
  });
  return best;
}

function updateAir(){
  // pressure diffusion + velocity from pressure gradient + damping
  // Integer math keeps it fast.
  const damp = 0.92;
  const diff = 0.18;

  // diffuse pressure
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
      const avg = cnt ? (sum / cnt) : 0;
      const np = (p + ((avg - p) * diff)) | 0;
      pField[i] = clamp(np, -32000, 32000);
    }
  }

  // velocity from pressure gradient
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

      vx = (vx * damp + (pl - pr) * 0.30) | 0;
      vy = (vy * damp + (pu - pd) * 0.30) | 0;

      // mild turbulence (makes it feel more alive)
      if (state.turb > 0 && (seed & 31) === 0) {
        const t = state.turb | 0;
        vx += (irand(2*t+1) - t) * 2;
        vy += (irand(2*t+1) - t) * 2;
      }

      // clamp
      vxField[i] = clamp(vx, -24000, 24000);
      vyField[i] = clamp(vy, -24000, 24000);

      // slow relax pressure too
      pField[i] = (p * 0.995) | 0;
    }
  }
}

function sampleAirVX(x,y){
  const ax = toAirX(x), ay = toAirY(y);
  return vxField[aidx(ax,ay)] | 0;
}
function sampleAirVY(x,y){
  const ax = toAirX(x), ay = toAirY(y);
  return vyField[aidx(ax,ay)] | 0;
}
function sampleAirBias(x,y){
  // returns +/- depending on wind; used to bias fluid flow
  const vx = sampleAirVX(x,y);
  return vx;
}

// Rendering helpers
function blend(a,b,t){
  // a,b Uint32 colors, t 0..1
  // unpack
  const ar = a & 255, ag = (a>>>8)&255, ab = (a>>>16)&255, aa = (a>>>24)&255;
  const br = b & 255, bg = (b>>>8)&255, bb = (b>>>16)&255, ba = (b>>>24)&255;
  const r = (ar + (br-ar)*t)|0;
  const g = (ag + (bg-ag)*t)|0;
  const bl = (ab + (bb-ab)*t)|0;
  const al = (aa + (ba-aa)*t)|0;
  return (al<<24) | (bl<<16) | (g<<8) | r;
}

function speedColor(v){
  // v is magnitude-ish 0..~24000
  const s = clamp((v / 22000), 0, 1);
  // blue -> cyan -> green -> yellow -> red
  if (s < 0.25) return blend(0xff1b2a7a, 0xff2fd1ff, s/0.25);
  if (s < 0.50) return blend(0xff2fd1ff, 0xff3ae36b, (s-0.25)/0.25);
  if (s < 0.75) return blend(0xff3ae36b, 0xffffd84a, (s-0.50)/0.25);
  return blend(0xffffd84a, 0xffff3a2a, (s-0.75)/0.25);
}

function render(){
  // base pixels
  for (let i=0; i<W*H; i++) {
    const t = typeA[i];
    let col = PALETTE[t];

    // small variations for life
    if (t===E.DIRT) {
      const m = dataA[i];
      const wet = clamp(m/200, 0, 1);
      const wetCol = 0xff4a2d1c; // darker
      col = blend(col, wetCol, wet*0.55);
    }
    if (t===E.WATER) {
      if ((seed & 31) === 0 && rnd()<0.02) col = blend(col, 0xffbdf3ff, 0.35);
    }
    if (t===E.PLANT) {
      const age = dataA[i];
      col = blend(col, 0xff26ff7a, clamp(age/140, 0, 1)*0.25);
    }
    if (t===E.FIRE) {
      col = blend(col, 0xffffff5a, rnd()*0.35);
    }
    if (t===E.SMOKE) {
      // smoke alpha already set in palette; keep it
      if (rnd()<0.03) col = blend(col, 0xffc8c8d2, 0.25);
    }

    pix32[i] = col;
  }

  ctx.putImageData(img, 0, 0);

  // Overlays
  if (state.visualize === 1) {
    drawWindHeatmap();
  } else if (state.visualize === 2) {
    drawVectors();
  } else if (state.visualize === 3) {
    drawTracers();
  }

  // crosshair / info
  drawCursorInfo();
}

function drawWindHeatmap(){
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (let ay=0; ay<aH; ay++) {
    for (let ax=0; ax<aW; ax++) {
      const i = aidx(ax,ay);
      const vx = vxField[i], vy = vyField[i];
      const mag = Math.abs(vx) + Math.abs(vy);
      const col = speedColor(mag);
      // convert Uint32 to rgba string cheap-ish
      const r = col & 255, g = (col>>>8)&255, b=(col>>>16)&255;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(ax*AIR_SCALE, ay*AIR_SCALE, AIR_SCALE, AIR_SCALE);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // legend
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(8, H-26, 260, 18);
  for (let k=0; k<250; k++) {
    const v = (k/249) * 22000;
    const col = speedColor(v);
    const r = col & 255, g = (col>>>8)&255, b=(col>>>16)&255;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(12+k, H-22, 1, 10);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = '12px ui-sans-serif, system-ui';
  ctx.fillText('Windstärke (relativ)  |  kalt → heiß', 12, H-28);
  ctx.restore();
}

function drawVectors(){
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  const step = AIR_SCALE * 4;
  for (let y=step/2; y<H; y+=step) {
    for (let x=step/2; x<W; x+=step) {
      const ax = toAirX(x), ay=toAirY(y);
      const i = aidx(ax,ay);
      const vx = vxField[i];
      const vy = vyField[i];
      const dx = clamp(vx/2500, -6, 6);
      const dy = clamp(vy/2500, -6, 6);
      ctx.beginPath();
      ctx.moveTo(x,y);
      ctx.lineTo(x+dx, y+dy);
      ctx.stroke();
    }
  }
  ctx.restore();
}

let tracerPhase = 0;
function drawTracers(){
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  tracerPhase = (tracerPhase + 1) % 6;
  for (let n=0; n<900; n++) {
    const x = (n*37 + tracerPhase*13) % W;
    const y = (n*91 + tracerPhase*7) % H;
    const vx = sampleAirVX(x,y);
    const vy = sampleAirVY(x,y);
    const dx = clamp(vx/2600, -4, 4);
    const dy = clamp(vy/2600, -4, 4);
    ctx.fillRect(x + dx, y + dy, 1, 1);
  }
  ctx.restore();
}

function drawCursorInfo(){
  // cursor overlay removed (kept for HUD sampling)
}

function kmhFromV(v){
  // Display-only scaling (tune this to taste)
  // v is Int16-ish, around [-24000..24000]
  // Map 24000 -> 120 km/h (looks believable for a sandbox)
  return Math.round(Math.abs(v) * (120/24000));
}

// Main loop
let lastT = 0;
let fps = 0;
let frameCount = 0;
let lastFpsT = 0;

function step(t){
  if (!lastT) lastT = t;
  const dt = t - lastT;
  lastT = t;

  if (!paused) {
    const strokes = Math.min(MAX_STROKES_PER_TICK, paintQueue.length);
    for (let i = 0; i < strokes; i++) {
      const entry = paintQueue.shift();
      if (entry) paintAt(entry.from.x, entry.from.y, entry.to.x, entry.to.y, entry.state);
    }
    // adaptive substeps (keeps it smooth when heavy)
    const sub = dt < 18 ? 2 : (dt < 30 ? 1 : 1);
    for (let k=0; k<sub; k++) {
      updatePowdersAndFluids();
      updateGasesAndBirds();
      updateFireAndLife();
      updateAir();
    }
  }

  render();

  frameCount++;
  if (!lastFpsT) lastFpsT = t;
  if (t - lastFpsT > 500) {
    fps = Math.round(frameCount * 1000 / (t - lastFpsT));
    frameCount = 0;
    lastFpsT = t;
  }

  maybeSendHud(t);

  setTimeout(() => step(performance.now()), 0);
}

function maybeSendHud(t){
  if (t - lastHudSend < 120) return;
  lastHudSend = t;

  const cx = clamp(cursorCell.x|0,0,W-1);
  const cy = clamp(cursorCell.y|0,0,H-1);
  const i = idx(cx,cy);
  const tt = typeA[i];

  const ax = toAirX(cx), ay = toAirY(cy);
  const ai = aidx(ax,ay);
  const vx = vxField[ai] | 0;
  const vy = vyField[ai] | 0;
  const p  = pField[ai] | 0;

  const kmh = Math.round(Math.hypot(kmhFromV(vx), kmhFromV(vy)));

  const text = `FPS ${fps}  |  Tool: ${state.tool}  |  Material: ${NAME_BY_ID[state.material] ?? state.material}  |  Brush: ${state.brush}px`;
  const text2 = `Cursor: (${cx},${cy})  |  Zelle: ${NAME_BY_ID[tt] ?? tt}  |  Wind: ~${kmh} km/h  |  Druck: ${p}`;
  postMessage({ type: 'hud', text, text2 });
}

// Messages
onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    canvas = msg.canvas;
    W = msg.simW|0;
    H = msg.simH|0;
    DPR = msg.dpr || 1;
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    resizeCanvasToFit();
    initBuffers();
    setTimeout(() => step(performance.now()), 0);
  }
  if (msg.type === 'state') {
    state = { ...state, ...msg.state };
  }
  if (msg.type === 'stroke') {
    if (paintQueue.length < MAX_PAINT_QUEUE) {
      paintQueue.push({ from: msg.from, to: msg.to, state: msg.state });
    }
  }
  if (msg.type === 'clear') {
    clearWorld();
  }
  if (msg.type === 'togglePause') {
    paused = !paused;
  }
  if (msg.type === 'cursor') {
    cursorCell.x = clamp((msg.x*W)|0, 0, W-1);
    cursorCell.y = clamp((msg.y*H)|0, 0, H-1);
  }
};
