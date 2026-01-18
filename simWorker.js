// simWorker.js (runs in a Web Worker)
import { E, PALETTE, DENSITY, IS_SOLID, IS_POWDER, IS_FLUID, IS_GAS, NAME_BY_ID } from './elements.js';

let canvas, ctx;
let W=640, H=360;

let typeA, dataA;
let paused = false;

// Coarse air grid (cheap but useful)
const AIR_SCALE = 4;
let aW, aH;
let pField, pNext, vxField, vyField; // Int16

// Active chunks (big-world enabler)
const CHUNK = 32;
let cW = 0, cH = 0;
let chunkActive, chunkSleep, chunkTouched;
const CHUNK_SLEEP_TICKS = 60;

// Rendering
let img, pix32;

// UI state
let state = {
  tool: 'paint',
  material: E.SAND,
  brush: 12,
  strength: 35,
  turb: 12,
  windAngle: 0,
  visualize: 0,
};

let lastWindDirX = 1;
let lastWindDirY = 0;

let canSendFrame = true;

let tick = 0;
let renderEvery = 1;

// Cursor sampling
let cursorCell = { x: 0, y: 0 };
let lastHudSend = 0;
const paintQueue = [];
let maxStrokesPerTick = 2;
let maxPaintQueue = 200;

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

function cidx(cx, cy) { return cx + cy * cW; }
function inChunkBounds(cx, cy) { return cx >= 0 && cx < cW && cy >= 0 && cy < cH; }
function markChunk(cx, cy) {
  if (!inChunkBounds(cx, cy)) return;
  const ci = cidx(cx, cy);
  chunkActive[ci] = 1;
  chunkSleep[ci] = 0;
  chunkTouched[ci] = 1;
}
function markChunkNeighbors(cx, cy) {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      markChunk(cx + ox, cy + oy);
    }
  }
}
function markIndex(i) {
  const x = i % W;
  const y = (i / W) | 0;
  markChunkNeighbors((x / CHUNK) | 0, (y / CHUNK) | 0);
}

function initChunks() {
  cW = Math.ceil(W / CHUNK);
  cH = Math.ceil(H / CHUNK);
  chunkActive = new Uint8Array(cW * cH);
  chunkSleep = new Uint16Array(cW * cH);
  chunkTouched = new Uint8Array(cW * cH);
  chunkActive.fill(1);
  chunkSleep.fill(0);
  chunkTouched.fill(1);
}

function beginTick() {
  if (chunkTouched) chunkTouched.fill(0);
}

function endTick() {
  if (!chunkActive) return;
  const n = chunkActive.length;
  for (let ci = 0; ci < n; ci++) {
    if (!chunkActive[ci]) continue;
    if (chunkTouched[ci]) {
      chunkSleep[ci] = 0;
    } else {
      const s = (chunkSleep[ci] + 1) | 0;
      chunkSleep[ci] = s;
      if (s > CHUNK_SLEEP_TICKS) chunkActive[ci] = 0;
    }
  }
}

function clearWorld(){
  typeA.fill(E.AIR);
  dataA.fill(0);
  pField.fill(0);
  pNext?.fill(0);
  vxField.fill(0);
  vyField.fill(0);

  chunkActive?.fill(1);
  chunkSleep?.fill(0);
  chunkTouched?.fill(1);
}

function resizeCanvasToFit(){
  // Worker renders at simulation resolution; main thread handles integer CSS scaling.
  canvas.width = W;
  canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.mozImageSmoothingEnabled = false;
  ctx.webkitImageSmoothingEnabled = false;
  ctx.msImageSmoothingEnabled = false;
}

function initBuffers(){
  typeA = new Uint8Array(W*H);
  dataA = new Uint8Array(W*H);

  aW = Math.ceil(W / AIR_SCALE);
  aH = Math.ceil(H / AIR_SCALE);
  pField  = new Int16Array(aW*aH);
  pNext   = new Int16Array(aW*aH);
  vxField = new Int16Array(aW*aH);
  vyField = new Int16Array(aW*aH);

  img = ctx.createImageData(W, H);
  pix32 = new Uint32Array(img.data.buffer);

  renderEvery = (W * H >= 960 * 540) ? 2 : 1;

  initChunks();

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

  // Direction for wind tool
  // - If the user drags: use stroke direction and remember it
  // - If the user clicks: use UI angle; fallback to last direction
  const ddx = x1 - x0;
  const ddy = y1 - y0;
  let dirx = lastWindDirX;
  let diry = lastWindDirY;
  const l2 = ddx*ddx + ddy*ddy;
  if (l2 > 0) {
    const len = Math.sqrt(l2) || 1;
    dirx = ddx / len;
    diry = ddy / len;
    lastWindDirX = dirx;
    lastWindDirY = diry;
  } else if (Number.isFinite(st?.windAngle)) {
    const a = (st.windAngle * Math.PI) / 180;
    dirx = Math.cos(a);
    diry = Math.sin(a);
    lastWindDirX = dirx;
    lastWindDirY = diry;
  }
  st = { ...st, dirx, diry };

  const r = st.brush|0;
  const tool = st.tool;

  const stamp = (x,y) => {
    if (!inb(x,y)) return;

    if (tool === 'erase') {
      const i = idx(x,y);
      typeA[i] = E.AIR;
      dataA[i] = 0;
      markIndex(i);
      return;
    }

    if (tool === 'paint') {
      const t = st.material|0;
      const i = idx(x,y);
      typeA[i] = t;
      // init state
      if (t===E.FIRE) dataA[i] = 40 + irand(50);
      else if (t===E.SMOKE) dataA[i] = 80 + irand(80);
      else if (t===E.STEAM) dataA[i] = 50 + irand(50); // shorter TTL than smoke
      else if (t===E.DIRT) dataA[i] = 30; // moisture
      else if (t===E.SEED) dataA[i] = 0;
      else if (t===E.PLANT) dataA[i] = 10;
      else if (t===E.MUD) dataA[i] = 180; // high moisture
      else dataA[i] = 0;
      markIndex(i);
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
      markChunkNeighbors((x / CHUNK) | 0, (y / CHUNK) | 0);
      return;
    }

    if (tool === 'pressure') {
      const s = st.strength|0;
      pField[ai] = clamp(pField[ai] + (s*30)|0, -32000, 32000);
      markChunkNeighbors((x / CHUNK) | 0, (y / CHUNK) | 0);
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
          markIndex(i);
        } else if (typeA[i]===E.ICE) {
          typeA[i]=E.WATER; dataA[i]=0;
          markIndex(i);
        } else if (typeA[i]===E.WATER && rnd()<0.02) {
          typeA[i]=E.STEAM; dataA[i]=60+irand(40);
          markIndex(i);
        } else if (typeA[i]===E.MUD && rnd()<0.01) {
          typeA[i]=E.DIRT; dataA[i]=10;
          markIndex(i);
        }
      } else if (s < 0) {
        if (typeA[i]===E.WATER && rnd()<0.4) {
          typeA[i]=E.ICE; dataA[i]=0;
          markIndex(i);
        } else if (typeA[i]===E.LAVA && rnd()<0.15) {
          typeA[i]=E.STONE; dataA[i]=0;
          markIndex(i);
        } else if (typeA[i]===E.STEAM && rnd()<0.3) {
          typeA[i]=E.WATER; dataA[i]=0;
          markIndex(i);
        }
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

  markIndex(i);
  markIndex(j);
}

function isEmptyForMove(t){
  return t===E.AIR || t===E.SMOKE || t===E.STEAM || t===E.FIRE || t===E.BIRD;
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
  // bottom-up pass for falling stuff (active chunks only)
  for (let cy=cH-1; cy>=0; cy--) {
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx, cy);
      if (!chunkActive[ci]) continue;

      const xMin = cx * CHUNK;
      const xMax = Math.min(W, xMin + CHUNK);
      const yMin = cy * CHUNK;
      const yMax = Math.min(H, yMin + CHUNK);

      for (let y=yMax-2; y>=yMin; y--) {
        const row = y*W;
        const dir = (y & 1) ? 1 : -1;
        let xStart = dir===1 ? xMin : (xMax-1);
        let xEnd   = dir===1 ? xMax : (xMin-1);

        for (let x=xStart; x!==xEnd; x+=dir) {
          const i = row + x;
          const t = typeA[i];

      if (t===E.SAND || t===E.DIRT || t===E.SEED || t===E.ASH) {
        // powders
        // dirt moves a bit slower to look heavier/"sticky"
        if (t===E.DIRT && (seed & 3) !== 0) continue;

        const bias = sampleAirVX(x,y);
        const vyAir = sampleAirVY(x,y);

        // ASH is extremely wind-affected, almost gas-like
        if (t===E.ASH) {
          // Strong horizontal wind can push ash sideways even before falling
          if (Math.abs(bias) > 200) {
            const sideDir = bias > 0 ? 1 : -1;
            const ni = i + sideDir;
            if (inb(x+sideDir, y) && typeA[ni]===E.AIR && rnd() < 0.6) {
              swap(i, ni);
              continue;
            }
          }
          // Strong upward wind can even lift ash slightly
          if (vyAir < -600 && y > 0) {
            const up = i - W;
            if (typeA[up]===E.AIR && rnd() < 0.25) { swap(i, up); continue; }
          }
        }

        // SEED is also lighter and more wind-affected
        if (t===E.SEED) {
          if (Math.abs(bias) > 400) {
            const sideDir = bias > 0 ? 1 : -1;
            const ni = i + sideDir;
            if (inb(x+sideDir, y) && typeA[ni]===E.AIR && rnd() < 0.35) {
              swap(i, ni);
              continue;
            }
          }
        }

        const below = i + W;
        if (below < W*H && tryMove(i, below)) continue;

        const dl = (x>0) ? (below-1) : -1;
        const dr = (x<W-1) ? (below+1) : -1;
        if (dl>=0 && dr>=0) {
          // Air bias nudges drift (stronger thresholds for lighter materials)
          const preferRight = bias > (t===E.ASH ? 100 : (t===E.SEED ? 200 : 900));
          const preferLeft  = bias < (t===E.ASH ? -100 : (t===E.SEED ? -200 : -900));
          if (preferLeft) { if (tryMove(i, dl)) continue; if (tryMove(i, dr)) continue; }
          else if (preferRight) { if (tryMove(i, dr)) continue; if (tryMove(i, dl)) continue; }
          else if (rnd()<0.5) { if (tryMove(i, dl)) continue; if (tryMove(i, dr)) continue; }
          else { if (tryMove(i, dr)) continue; if (tryMove(i, dl)) continue; }
        } else if (dl>=0) {
          tryMove(i, dl);
        } else if (dr>=0) {
          tryMove(i, dr);
        }
      }

      if (t===E.WATER || t===E.OIL || t===E.LAVA || t===E.MUD) {
        const visc = (t===E.LAVA) ? 3 : (t===E.MUD ? 2 : 1);
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
        if (dl>=0 && (typeA[dl]===E.AIR || typeA[dl]===E.SMOKE || typeA[dl]===E.STEAM)) { if (rnd()<0.5){ swap(i,dl); continue; } }
        if (dr>=0 && (typeA[dr]===E.AIR || typeA[dr]===E.SMOKE || typeA[dr]===E.STEAM)) { swap(i,dr); continue; }

        // sideways flow
        const left  = (x>0) ? (i-1) : -1;
        const right = (x<W-1) ? (i+1) : -1;

        // oil prefers to sit on water
        if (t===E.OIL) {
          if (left>=0 && typeA[left]===E.AIR) { if (rnd()<0.5){ swap(i,left); continue; } }
          if (right>=0 && typeA[right]===E.AIR) { swap(i,right); continue; }
        } else {
          const bias = sampleAirBias(x,y);

          // WATER surface drift: when water has air above, wind affects it more
          if (t===E.WATER) {
            const above = i - W;
            const hasAirAbove = (y > 0 && typeA[above]===E.AIR);
            if (hasAirAbove && Math.abs(bias) > 300) {
              // Surface water drifts with wind
              const driftDir = bias > 0 ? 1 : -1;
              const ni = i + driftDir;
              if (inb(x+driftDir, y) && (typeA[ni]===E.AIR || typeA[ni]===E.SMOKE)) {
                if (rnd() < 0.4) { swap(i, ni); continue; }
              }
            }
          }

          if (bias < 0) {
            if (left>=0 && (typeA[left]===E.AIR || typeA[left]===E.SMOKE || typeA[left]===E.STEAM)) { swap(i,left); continue; }
            if (right>=0 && (typeA[right]===E.AIR || typeA[right]===E.SMOKE || typeA[right]===E.STEAM)) { swap(i,right); continue; }
          } else {
            if (right>=0 && (typeA[right]===E.AIR || typeA[right]===E.SMOKE || typeA[right]===E.STEAM)) { swap(i,right); continue; }
            if (left>=0 && (typeA[left]===E.AIR || typeA[left]===E.SMOKE || typeA[left]===E.STEAM)) { swap(i,left); continue; }
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
        // lava burns things and can turn water into steam + stone
        if (hasNeighbor(i, E.WATER)) {
          if (rnd() < 0.35) {
            // cool down -> stone + create steam from water + pressure burst
            typeA[i] = E.STONE;
            dataA[i] = 0;
            // Convert some nearby water to steam and add pressure burst
            const ax = toAirX(x), ay = toAirY(y);
            const ai = aidx(ax, ay);
            pField[ai] = clamp(pField[ai] + 2000, -32000, 32000);
            forEachNeighbor(i, (ni) => {
              if (typeA[ni] === E.WATER && rnd() < 0.6) {
                typeA[ni] = E.STEAM;
                dataA[ni] = 60 + irand(60);
                markIndex(ni);
              }
            });
            markIndex(i);
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
  }
}

function updateGasesAndBirds(){
  // top-down pass for rising smoke, plus birds flying (active chunks only)
  for (let cy=0; cy<cH; cy++) {
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx, cy);
      if (!chunkActive[ci]) continue;

      const xMin = cx * CHUNK;
      const xMax = Math.min(W, xMin + CHUNK);
      const yMin = cy * CHUNK;
      const yMax = Math.min(H, yMin + CHUNK);

      for (let y=Math.max(1, yMin); y<yMax; y++) {
        const row = y*W;
        const dir = (y & 1) ? 1 : -1;
        let xStart = dir===1 ? xMin : (xMax-1);
        let xEnd   = dir===1 ? xMax : (xMin-1);

        for (let x=xStart; x!==xEnd; x+=dir) {
          const i = row + x;
          const t = typeA[i];

      if (t===E.SMOKE || t===E.STEAM) {
        let ttl = dataA[i];
        if (ttl>0) { dataA[i] = ttl-1; markIndex(i); }
        else {
          // Steam can condense back to water at low pressure, smoke just disappears
          if (t===E.STEAM) {
            const ai = aidx(toAirX(x), toAirY(y));
            if (pField[ai] < -500 && rnd() < 0.15) {
              typeA[i] = E.WATER;
              dataA[i] = 0;
              markIndex(i);
              continue;
            }
          }
          typeA[i]=E.AIR; dataA[i]=0; markIndex(i); continue;
        }

        const ax = sampleAirVX(x,y);
        const ay = sampleAirVY(x,y);
        // Stronger wind response - use lower thresholds
        const driftThresh = (t===E.STEAM) ? 150 : 200;
        const sideways = ax < -driftThresh ? -1 : (ax > driftThresh ? 1 : (rnd()<0.5?-1:1));

        // Smoke/Steam is much more "carried" by air - stronger coupling
        const up = i - W;
        // Strong upward wind carries gas up faster
        if (ay < -300 && up>=0 && typeA[up]===E.AIR) { swap(i,up); continue; }
        // Natural rise (steam rises faster than smoke)
        const riseChance = (t===E.STEAM) ? 0.85 : 0.75;
        if (up>=0 && typeA[up]===E.AIR && rnd()<riseChance) { swap(i,up); continue; }
        const ul = (x>0) ? (up-1) : -1;
        const ur = (x<W-1) ? (up+1) : -1;
        if (sideways<0) {
          if (ul>=0 && typeA[ul]===E.AIR) { swap(i,ul); continue; }
          if (ur>=0 && typeA[ur]===E.AIR) { swap(i,ur); continue; }
        } else {
          if (ur>=0 && typeA[ur]===E.AIR) { swap(i,ur); continue; }
          if (ul>=0 && typeA[ul]===E.AIR) { swap(i,ul); continue; }
        }

        // Horizontal drift based on wind strength - stronger coupling
        const driftChance = Math.min(0.8, Math.abs(ax) / 1500);
        if (rnd() < driftChance) {
          const ni = i + sideways;
          if (ni>=0 && ni<W*H && typeA[ni]===E.AIR) { swap(i,ni); continue; }
        }

        // Random drift for liveliness
        if (rnd() < 0.15) {
          const ni = i + sideways;
          if (ni>=0 && ni<W*H && typeA[ni]===E.AIR) { swap(i,ni); }
        }
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
  }
}

function updateFireAndLife(){
  // fire + seeds + plants + moisture cycling (active chunks only)
  for (let cy=0; cy<cH; cy++) {
    for (let cx=0; cx<cW; cx++) {
      const ci = cidx(cx, cy);
      if (!chunkActive[ci]) continue;

      const xMin = cx * CHUNK;
      const xMax = Math.min(W, xMin + CHUNK);
      const yMin = cy * CHUNK;
      const yMax = Math.min(H, yMin + CHUNK);

      for (let y=yMin; y<yMax; y++) {
        const row = y*W;
        for (let x=xMin; x<xMax; x++) {
          const i = row + x;
          const t = typeA[i];

      if (t===E.FIRE) {
        let ttl = dataA[i];
        if (ttl>0) { dataA[i] = ttl-1; markIndex(i); }
        else {
          typeA[i] = (rnd()<0.6) ? E.SMOKE : E.AIR;
          dataA[i] = (typeA[i]===E.SMOKE) ? 120+irand(80) : 0;
          markIndex(i);
          continue;
        }

        // spread
        if (rnd() < 0.45) igniteNeighbors(i);

        // burn oil hard
        if (hasNeighbor(i, E.OIL) && rnd()<0.35) igniteNeighbors(i);

        // evaporate water locally (create steam, not smoke)
        if (hasNeighbor(i, E.WATER) && rnd()<0.22) {
          forEachNeighbor(i,(ni)=>{
            if (typeA[ni]===E.WATER && rnd()<0.3) { typeA[ni]=E.STEAM; dataA[ni]=60+irand(60); markIndex(ni); }
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
        if (m !== dataA[i]) { dataA[i] = m; markIndex(i); }
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
                markIndex(i);
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
        if (age !== dataA[i]) { dataA[i] = age; markIndex(i); }

        // turn to wood trunk
        if (age > 90 && rnd()<0.02) {
          typeA[i] = E.WOOD;
          dataA[i] = 0;
          markIndex(i);
        }

        // sprout upward
        if (age > 20 && rnd() < 0.08) {
          const up = i - W;
          if (up>=0 && typeA[up]===E.AIR) {
            typeA[up] = E.PLANT;
            dataA[up] = 10;
            markIndex(up);
          }
        }

        // die if too dry
        if (moist < 8 && !hasNeighbor(i, E.WATER) && rnd()<0.01) {
          typeA[i] = E.ASH;
          dataA[i] = 0;
          markIndex(i);
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

        // Water + Sand nearby → turn sand to mud (small chance per tick)
        if (hasNeighbor(i, E.SAND) && rnd() < 0.03) {
          forEachNeighbor(i, (ni) => {
            if (typeA[ni] === E.SAND && rnd() < 0.5) {
              typeA[ni] = E.MUD;
              dataA[ni] = 200; // high moisture
              markIndex(ni);
            }
          });
        }
      }

      if (t===E.MUD) {
        // Mud dries slowly over time to become dirt
        let moisture = dataA[i];
        if (moisture > 0) {
          // Dry faster near fire
          if (hasNeighbor(i, E.FIRE)) moisture = Math.max(0, moisture - 5);
          else if (rnd() < 0.02) moisture--;
          dataA[i] = moisture;
          markIndex(i);
        }
        if (moisture === 0 && rnd() < 0.05) {
          typeA[i] = E.DIRT;
          dataA[i] = 30; // some moisture in new dirt
          markIndex(i);
        }
        // Mud gets wetter from water
        if (hasNeighbor(i, E.WATER) && moisture < 250) {
          dataA[i] = Math.min(250, moisture + 3);
        }
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
  }
}

function igniteNeighbors(i){
  forEachNeighbor(i,(ni)=>{
    const t = typeA[ni];
    if (t===E.WOOD || t===E.PLANT || t===E.OIL || t===E.ASH) {
      if (rnd() < 0.22) {
        typeA[ni] = E.FIRE;
        dataA[ni] = 40 + irand(80);
        markIndex(ni);
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
  const damp = 0.96;
  const diff = 0.22;
  const grad = 0.45;
  const buoy = 0.01;

  // Ambient turbulence: adds light random drift to make world feel alive
  // This creates subtle air movement even when player does nothing
  const ambientTurb = 8; // low constant ambient turbulence

  // diffuse pressure (double buffer so it doesn't "self-smear" in-place)
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
      pNext[i] = clamp(np, -32000, 32000);
    }
  }

  // swap buffers
  const tmp = pField;
  pField = pNext;
  pNext = tmp;

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

      vx = (vx * damp + (pl - pr) * grad) | 0;
      // positive pressure gently rises (canvas y+ is down -> subtract)
      vy = (vy * damp + (pu - pd) * grad - p * buoy) | 0;

      // mild turbulence (makes it feel more alive)
      // Always add some ambient turbulence for liveliness
      if ((seed & 31) === 0) {
        const t = Math.max(ambientTurb, state.turb | 0);
        vx += (irand(2*t+1) - t) * 2;
        vy += (irand(2*t+1) - t) * 2;
      }

      // Extra random micro-drift for ambient movement (always on)
      if ((seed & 127) === 0) {
        vx += irand(5) - 2;
        vy += irand(3) - 1;
      }

      // clamp
      vxField[i] = clamp(vx, -24000, 24000);
      vyField[i] = clamp(vy, -24000, 24000);

      // slow relax pressure too
      pField[i] = (p * 0.998) | 0;
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
    if (t===E.STEAM) {
      // steam with slight shimmer
      if (rnd()<0.04) col = blend(col, 0xffffffff, 0.25);
    }
    if (t===E.MUD) {
      // mud color varies with moisture (wetter = darker)
      const moisture = dataA[i];
      const wet = clamp(moisture/250, 0, 1);
      const wetCol = 0xff3a2812; // very dark muddy
      col = blend(col, wetCol, wet*0.4);
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

  // Push a frame to main thread (at most one in-flight).
  if (canSendFrame) {
    const bitmap = canvas.transferToImageBitmap();
    postMessage({ type: 'frame', bitmap }, [bitmap]);
    canSendFrame = false;
  }
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
  tick++;
  if (!lastT) lastT = t;
  const dt = t - lastT;
  lastT = t;

  if (!paused) {
    beginTick();
    const strokes = Math.min(maxStrokesPerTick, paintQueue.length);
    for (let i = 0; i < strokes; i++) {
      const entry = paintQueue.shift();
      if (entry) paintAt(entry.from.x, entry.from.y, entry.to.x, entry.to.y, entry.state);
    }

    // adaptive substeps for powders/fluids only (biggest impact on feel)
    const sub = dt < 18 ? 2 : 1;
    for (let k=0; k<sub; k++) updatePowdersAndFluids();

    // Stagger heavier layers across frames
    if ((tick & 1) === 0) {
      updateGasesAndBirds();
      updateAir();
    }
    if ((tick & 3) === 0) {
      updateFireAndLife();
    }

    endTick();
  }

  // Render only when we can actually ship a frame (backpressure) and on cadence.
  if (canSendFrame && (tick % renderEvery) === 0) {
    render();
  }

  frameCount++;
  if (!lastFpsT) lastFpsT = t;
  if (t - lastFpsT > 500) {
    fps = Math.round(frameCount * 1000 / (t - lastFpsT));
    frameCount = 0;
    lastFpsT = t;
  }

  maybeSendHud(t);

  // Cap loop to ~60fps to avoid pegging CPU
  const target = 1000 / 60;
  const delay = Math.max(0, target - dt);
  setTimeout(() => step(performance.now()), delay);
}

function maybeSendHud(t){
  if (t - lastHudSend < 120) return;
  lastHudSend = t;

  // Adaptive paint budget (quick win for big brushes + fast painting)
  const qLen = paintQueue.length;
  if (fps < 30 || qLen > 180) {
    maxStrokesPerTick = 1;
    maxPaintQueue = 120;
  } else if (fps < 45 || qLen > 120) {
    maxStrokesPerTick = 1;
    maxPaintQueue = 160;
  } else {
    maxStrokesPerTick = 2;
    maxPaintQueue = 220;
  }

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
  const text2 = `Cursor: (${cx},${cy})  |  Zelle: ${NAME_BY_ID[tt] ?? tt}  |  Wind: ~${kmh} km/h  |  Druck: ${p}  |  Queue: ${paintQueue.length}`;
  postMessage({ type: 'hud', text, text2, fps, queue: paintQueue.length, w: W, h: H });
}

// Messages
onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    W = msg.simW|0;
    H = msg.simH|0;
    canvas = new OffscreenCanvas(W, H);
    ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    resizeCanvasToFit();
    initBuffers();
    setTimeout(() => step(performance.now()), 0);
  }
  if (msg.type === 'state') {
    state = { ...state, ...msg.state };
    state.brush = clamp(state.brush|0, 1, 80);
  }
  if (msg.type === 'stroke') {
    if (paintQueue.length < maxPaintQueue) {
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
  if (msg.type === 'frameAck') {
    canSendFrame = true;
  }
};
