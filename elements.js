// elements.js — IDs, palette, densities and flags

export const E = {
  AIR: 0,
  STONE: 1,
  SAND: 2,
  WATER: 3,
  DIRT: 4,
  MUD: 5,
  SEED: 6,
  SPROUT: 7,
  PLANT: 8,
  WOOD: 9,
  FIRE: 10,
  SMOKE: 11,
  STEAM: 12,
  ICE: 13,
  OIL: 14,
  LAVA: 15,
  ASH: 16,
  SPARK: 17,
  GRAVEL: 18,
  CLOUD: 19,
  // === NEW CORE ELEMENTS ===
  METAL: 20,
  LIGHTNING: 21,
  // === NEW EXPANSION ELEMENTS ===
  ACID: 22,
  SOAP: 23,
  GAS: 24,        // Methan - unsichtbar, entzündlich
  NITRO: 25,      // Extrem instabil
  FIREWORK: 26,   // Partikel mit Timer
  VINE: 27,       // Rebe - wächst seitlich/klettert
  ANT: 28,        // Ameisen-Schwarm
  RUST: 29,       // Rost - aus Metall+Wasser
  FOAM: 30,       // Seifenschaum
  LASER: 31,      // Laser-Strahl (Tool-generiert)
  CLONE: 32,      // Klon-Marker
};

// What the player can paint as “material”
export const MATERIALS = [
  // === CORE ===
  { id: E.SAND,  name: 'Sand' },
  { id: E.WATER, name: 'Wasser' },
  { id: E.DIRT,  name: 'Erde' },
  { id: E.STONE, name: 'Stein' },
  { id: E.GRAVEL, name: 'Kiesel' },
  { id: E.METAL, name: 'Metall' },
  { id: E.SEED,  name: 'Samen' },
  { id: E.PLANT, name: 'Pflanze' },
  { id: E.WOOD,  name: 'Holz' },
  { id: E.FIRE,  name: 'Feuer' },
  { id: E.SMOKE, name: 'Rauch' },
  { id: E.STEAM, name: 'Dampf' },
  { id: E.CLOUD, name: 'Wolke' },
  { id: E.ICE,   name: 'Eis' },
  { id: E.OIL,   name: 'Oel' },
  { id: E.LAVA,  name: 'Lava' },
  { id: E.ASH,   name: 'Asche' },
  { id: E.MUD,   name: 'Schlamm' },
  // === EXPANSION ===
  { id: E.ACID, name: 'Säure' },
  { id: E.SOAP, name: 'Seife' },
  { id: E.GAS, name: 'Gas' },
  { id: E.NITRO, name: 'Nitro' },
  { id: E.FIREWORK, name: 'Feuerwerk' },
  { id: E.VINE, name: 'Rebe' },
  { id: E.ANT, name: 'Ameisen' },
];

export const NAME_BY_ID = Object.fromEntries([
  ...MATERIALS.map(m => [m.id, m.name]),
  [E.AIR, 'Luft'],
  [E.SPROUT, 'Keimling'],
  [E.SPARK, 'Funke'],
  [E.GRAVEL, 'Kiesel'],
  [E.CLOUD, 'Wolke'],
  [E.LIGHTNING, 'Blitz'],
  [E.RUST, 'Rost'],
  [E.FOAM, 'Schaum'],
  [E.LASER, 'Laser'],
  [E.CLONE, 'Klon'],
]);

// Uint32 packed colors for little-endian: 0xAABBGGRR (fast for ImageData)
export const PALETTE = new Uint32Array(256);
function c(r,g,b,a=255){ return (a<<24) | (b<<16) | (g<<8) | (r<<0); }

PALETTE[E.AIR]   = c(8,  10, 14, 255);
PALETTE[E.STONE] = c(120,125,135,255);
PALETTE[E.SAND]  = c(208,187,118,255);
PALETTE[E.WATER] = c(60, 120,220,255);
PALETTE[E.DIRT]  = c(130, 95, 60,255);
PALETTE[E.MUD]   = c(90,  70, 55,255);
PALETTE[E.SEED]  = c(180,150, 90,255);
PALETTE[E.SPROUT]= c(90, 210,120,255);
PALETTE[E.PLANT] = c(70, 200,110,255);
PALETTE[E.WOOD]  = c(150,110, 70,255);
PALETTE[E.FIRE]  = c(255,140, 30,255);
PALETTE[E.SMOKE] = c(150,150,160,180);
PALETTE[E.STEAM] = c(220,230,240,160);
PALETTE[E.ICE]   = c(170,220,255,230);
PALETTE[E.OIL]   = c(30,  30, 40,255);
PALETTE[E.LAVA]  = c(255, 60, 10,255);
PALETTE[E.ASH]   = c(90,  90, 95,255);
PALETTE[E.SPARK] = c(255, 220, 80,200);
PALETTE[E.GRAVEL]= c(125,120,115,255);
PALETTE[E.CLOUD] = c(210,215,225,200);
// === NEW ELEMENTS ===
PALETTE[E.METAL] = c(180,185,195,255);
PALETTE[E.LIGHTNING] = c(200,220,255,255);
PALETTE[E.ACID] = c(120,255,80,220);
PALETTE[E.SOAP] = c(240,200,220,200);
PALETTE[E.GAS] = c(60, 80, 60, 40);   // fast unsichtbar
PALETTE[E.NITRO] = c(255,230,140,255);
PALETTE[E.FIREWORK] = c(255,100,150,255);
PALETTE[E.VINE] = c(50, 160, 80,255);
PALETTE[E.ANT] = c(40, 30, 25,255);
PALETTE[E.RUST] = c(160, 80, 50,255);
PALETTE[E.FOAM] = c(245,250,255,180);
PALETTE[E.LASER] = c(255,50,50,255);
PALETTE[E.CLONE] = c(200,100,255,200);

// Relative densities (0..9). Higher sinks.
export const DENSITY = new Int8Array(256);
DENSITY[E.AIR]=0;
DENSITY[E.SMOKE]=1;
DENSITY[E.STEAM]=1;
DENSITY[E.CLOUD]=1;
DENSITY[E.GAS]=1;
DENSITY[E.FIRE]=0;
DENSITY[E.SPARK]=0;
DENSITY[E.LIGHTNING]=0;
DENSITY[E.FOAM]=2;
DENSITY[E.WATER]=3;
DENSITY[E.OIL]=2;
DENSITY[E.ACID]=3;
DENSITY[E.SOAP]=3;
DENSITY[E.ICE]=4;
DENSITY[E.ASH]=4;
DENSITY[E.SAND]=5;
DENSITY[E.DIRT]=5;
DENSITY[E.SEED]=5;
DENSITY[E.SPROUT]=5;
DENSITY[E.PLANT]=5;
DENSITY[E.VINE]=5;
DENSITY[E.ANT]=4;
DENSITY[E.NITRO]=4;
DENSITY[E.FIREWORK]=4;
DENSITY[E.MUD]=4;
DENSITY[E.RUST]=6;
DENSITY[E.WOOD]=7;
DENSITY[E.GRAVEL]=7;
DENSITY[E.LAVA]=8;
DENSITY[E.METAL]=9;
DENSITY[E.STONE]=9;
DENSITY[E.LASER]=0;
DENSITY[E.CLONE]=5;

export const IS_SOLID = new Uint8Array(256);
IS_SOLID[E.STONE]=1;
IS_SOLID[E.WOOD]=1;
IS_SOLID[E.ICE]=1;
IS_SOLID[E.METAL]=1;

export const IS_POWDER = new Uint8Array(256);
IS_POWDER[E.SAND]=1;
IS_POWDER[E.DIRT]=1;
IS_POWDER[E.SEED]=1;
IS_POWDER[E.ASH]=1;
IS_POWDER[E.GRAVEL]=1;
IS_POWDER[E.RUST]=1;
IS_POWDER[E.ANT]=1;
IS_POWDER[E.NITRO]=1;
IS_POWDER[E.FIREWORK]=1;

export const IS_FLUID = new Uint8Array(256);
IS_FLUID[E.WATER]=1;
IS_FLUID[E.OIL]=1;
IS_FLUID[E.LAVA]=1;
IS_FLUID[E.MUD]=1;
IS_FLUID[E.ACID]=1;
IS_FLUID[E.SOAP]=1;

export const IS_GAS = new Uint8Array(256);
IS_GAS[E.SMOKE]=1;
IS_GAS[E.STEAM]=1;
IS_GAS[E.FIRE]=1;
IS_GAS[E.SPARK]=1;
IS_GAS[E.CLOUD]=1;
IS_GAS[E.GAS]=1;
IS_GAS[E.FOAM]=1;
IS_GAS[E.LIGHTNING]=1;
IS_GAS[E.LASER]=1;

export const IS_BURNABLE = new Uint8Array(256);
IS_BURNABLE[E.WOOD]=1;
IS_BURNABLE[E.PLANT]=1;
IS_BURNABLE[E.SPROUT]=1;
IS_BURNABLE[E.OIL]=1;
IS_BURNABLE[E.SEED]=1;
IS_BURNABLE[E.VINE]=1;
IS_BURNABLE[E.GAS]=1;
IS_BURNABLE[E.NITRO]=1;
IS_BURNABLE[E.FIREWORK]=1;

// Elements that Acid dissolves
export const IS_ORGANIC = new Uint8Array(256);
IS_ORGANIC[E.WOOD]=1;
IS_ORGANIC[E.PLANT]=1;
IS_ORGANIC[E.SPROUT]=1;
IS_ORGANIC[E.SEED]=1;
IS_ORGANIC[E.VINE]=1;
IS_ORGANIC[E.ANT]=1;
IS_ORGANIC[E.DIRT]=1;

// Elements that conduct electricity
export const IS_CONDUCTIVE = new Uint8Array(256);
IS_CONDUCTIVE[E.METAL]=1;
IS_CONDUCTIVE[E.WATER]=1;
IS_CONDUCTIVE[E.ACID]=1;

export function isEmptyCell(t){
  return t===E.AIR || t===E.SMOKE || t===E.STEAM || t===E.SPARK || t===E.CLOUD || t===E.GAS || t===E.FOAM || t===E.LIGHTNING || t===E.LASER;
}

export function isGasLike(t){
  return IS_GAS[t]===1 || t===E.AIR;
}

// Wind coupling factor per element (0 = not affected, 1 = fully affected)
// Determines how strongly wind pushes each material
// Based on realistic wind physics - light materials fly, heavy stay put
export const WIND_COUPLING = new Float32Array(256);

// === VERY LIGHT (fully affected by any wind) ===
// Smoke/Steam/Ash: 1.0 - fliegt bei jedem Windhauch
WIND_COUPLING[E.SMOKE] = 1.0;
WIND_COUPLING[E.STEAM] = 1.0;
WIND_COUPLING[E.ASH] = 1.0;    // Erhöht: Asche ist sehr leicht
WIND_COUPLING[E.GAS] = 1.0;
WIND_COUPLING[E.SPARK] = 0.95;
WIND_COUPLING[E.FOAM] = 0.90;
WIND_COUPLING[E.FIRE] = 0.85;  // Feuer flackert stark im Wind
WIND_COUPLING[E.CLOUD] = 0.75;

// === LIGHT PARTICLES (0.6-0.8) ===
// Seeds/Insects: stark betroffen, aber nicht ganz so leicht wie Rauch
WIND_COUPLING[E.SEED] = 0.70;
WIND_COUPLING[E.ANT] = 0.65;   // Erhöht: Insekten werden vom Wind erfasst
WIND_COUPLING[E.FIREWORK] = 0.65;

// === WATER SURFACE (0.2-0.4) ===
// Nur Oberfläche wird beeinflusst (Wellen)
WIND_COUPLING[E.WATER] = 0.35;
WIND_COUPLING[E.OIL] = 0.30;
WIND_COUPLING[E.ACID] = 0.32;
WIND_COUPLING[E.SOAP] = 0.38;
WIND_COUPLING[E.MUD] = 0.10;

// === SAND/DIRT (0.05-0.2) ===
// Nur bei starkem Wind, sonst nur Bias
WIND_COUPLING[E.SAND] = 0.15;
WIND_COUPLING[E.DIRT] = 0.10;
WIND_COUPLING[E.NITRO] = 0.18;
WIND_COUPLING[E.RUST] = 0.06;

// === HEAVY MATERIALS ===
// Gravel: fast 0 - braucht Sturm
WIND_COUPLING[E.GRAVEL] = 0.03;
WIND_COUPLING[E.LAVA] = 0.01;  // Fast keine Bewegung

// === PLANTS ===
// Leichtes Schwanken im Wind
WIND_COUPLING[E.PLANT] = 0.12;
WIND_COUPLING[E.SPROUT] = 0.22;
WIND_COUPLING[E.VINE] = 0.18;

// === SOLIDS (immovable) ===
WIND_COUPLING[E.STONE] = 0.0;
WIND_COUPLING[E.WOOD] = 0.0;
WIND_COUPLING[E.METAL] = 0.0;
WIND_COUPLING[E.ICE] = 0.0;
