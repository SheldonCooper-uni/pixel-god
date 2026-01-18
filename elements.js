export const E = {
  AIR: 0,
  STONE: 1,
  SAND: 2,
  WATER: 3,
  DIRT: 4,
  SEED: 5,
  PLANT: 6,
  WOOD: 7,
  FIRE: 8,
  SMOKE: 9,
  HUMAN: 10,
  BIRD: 11,
  ICE: 12,
  OIL: 13,
  LAVA: 14,
  ASH: 15,
  STEAM: 16,
  MUD: 17,
};

export const MATERIALS = [
  { id: E.SAND,  name: 'Sand' },
  { id: E.WATER, name: 'Wasser' },
  { id: E.DIRT,  name: 'Erde' },
  { id: E.STONE, name: 'Stein' },
  { id: E.SEED,  name: 'Samen' },
  { id: E.PLANT, name: 'Pflanze' },
  { id: E.WOOD,  name: 'Holz' },
  { id: E.FIRE,  name: 'Feuer' },
  { id: E.SMOKE, name: 'Rauch' },
  { id: E.STEAM, name: 'Dampf' },
  { id: E.ICE,   name: 'Eis' },
  { id: E.OIL,   name: 'Oel' },
  { id: E.LAVA,  name: 'Lava' },
  { id: E.ASH,   name: 'Asche' },
  { id: E.MUD,   name: 'Schlamm' },
  { id: E.HUMAN, name: 'Mensch' },
  { id: E.BIRD,  name: 'Vogel' },
];

// Uint32 packed colors for little-endian (ABGR in memory -> RGBA on canvas)
// helper: 0xAABBGGRR
export const PALETTE = new Uint32Array(256);
function c(r,g,b,a=255){ return (a<<24) | (b<<16) | (g<<8) | (r<<0); }

PALETTE[E.AIR]   = c(8,  10, 14, 255);
PALETTE[E.STONE] = c(120,125,135,255);
PALETTE[E.SAND]  = c(208,187,118,255);
PALETTE[E.WATER] = c(60, 120,220,255);
PALETTE[E.DIRT]  = c(130, 95, 60,255);
PALETTE[E.SEED]  = c(180,150,90,255);
PALETTE[E.PLANT] = c(70, 200,110,255);
PALETTE[E.WOOD]  = c(150,110,70,255);
PALETTE[E.FIRE]  = c(255,140,30,255);
PALETTE[E.SMOKE] = c(150,150,160,180);
PALETTE[E.HUMAN] = c(240,220,200,255);
PALETTE[E.BIRD]  = c(230,230,245,255);
PALETTE[E.ICE]   = c(170,220,255,230);
PALETTE[E.OIL]   = c(30,  30, 40,255);
PALETTE[E.LAVA]  = c(255,60,  10,255);
PALETTE[E.ASH]   = c(90,  90, 95,255);
PALETTE[E.STEAM] = c(200, 210,230,160);
PALETTE[E.MUD]   = c(85,  65, 45,255);

export const DENSITY = new Int8Array(256);
DENSITY[E.AIR]=0;
DENSITY[E.SMOKE]=1;
DENSITY[E.BIRD]=1;
DENSITY[E.WATER]=3;
DENSITY[E.OIL]=2;
DENSITY[E.SAND]=5;
DENSITY[E.DIRT]=5;
DENSITY[E.SEED]=5;
DENSITY[E.PLANT]=5;
DENSITY[E.ASH]=4;
DENSITY[E.ICE]=4;
DENSITY[E.HUMAN]=6;
DENSITY[E.WOOD]=7;
DENSITY[E.STONE]=9;
DENSITY[E.LAVA]=8;
DENSITY[E.FIRE]=0;
DENSITY[E.STEAM]=1;
DENSITY[E.MUD]=5;

export const IS_SOLID = new Uint8Array(256);
IS_SOLID[E.STONE]=1;
IS_SOLID[E.WOOD]=1;
IS_SOLID[E.ICE]=1;

export const IS_POWDER = new Uint8Array(256);
IS_POWDER[E.SAND]=1;
IS_POWDER[E.DIRT]=1;
IS_POWDER[E.SEED]=1;
IS_POWDER[E.ASH]=1;

export const IS_FLUID = new Uint8Array(256);
IS_FLUID[E.WATER]=1;
IS_FLUID[E.OIL]=1;
IS_FLUID[E.LAVA]=1;
IS_FLUID[E.MUD]=1;

export const IS_GAS = new Uint8Array(256);
IS_GAS[E.SMOKE]=1;
IS_GAS[E.FIRE]=1;
IS_GAS[E.STEAM]=1;

export const NAME_BY_ID = Object.fromEntries(MATERIALS.map(m=>[m.id,m.name]));
