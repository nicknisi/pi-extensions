/**
 * Michael Grinich pixel art sprite data.
 * Extracted from a photo and quantized to 18 colors.
 * 32×32 pixel grid, rendered with half-block terminal characters.
 */

export type RGB = [number, number, number];

export const MG_PALETTE: RGB[] = [
  [159, 159, 181], // 0: background light blue-gray (transparent)
  [188, 189, 210], // 1: background lighter (transparent)
  [56, 54, 59], // 2: hair dark gray-brown
  [97, 96, 103], // 3: hair medium gray
  [1, 0, 0], // 4: hair darkest / eyes
  [135, 136, 148], // 5: hair light gray
  [36, 33, 32], // 6: hair black
  [86, 63, 52], // 7: skin dark brown
  [221, 223, 237], // 8: background very light (transparent)
  [139, 98, 79], // 9: skin medium-dark
  [164, 120, 101], // a: skin medium
  [189, 140, 119], // b: skin tan
  [214, 165, 143], // c: skin light
  [113, 77, 63], // d: skin shadow / mouth
  [195, 181, 184], // e: mouth pinkish
  [173, 155, 153], // f: jaw shadow
  [129, 119, 118], // g: neck shadow
  [63, 39, 24], // h: neck dark
];

export const MG_TRANSPARENT = new Set([0, 1, 8]);

export const SPRITE_W = 32;
export const SPRITE_H = 32;

export const MG_GRID: string[] = [
  '00000000000011111111111111111111',
  '00000000001102332301111111111111',
  '00000000111024444423011111111111',
  '00000001115564444444211111111111',
  '00000011134644444444631111111111',
  '00001111024444444466662111111111',
  '00011115444666222772664581111111',
  '00111112446799aaabaa766288811111',
  '011111124699abbbccbba26618881111',
  '011111124299abbccccbb96618881111',
  '11111116479abbbcccccba6288881111',
  '11111112479aabbcccccba2288881111',
  '11111112479aabcccccbaa2288881111',
  '1111118247dd9abbca99992288881111',
  '111118854799999bba99aa7388881111',
  '111118856972799bb9739b9d88881111',
  '111118897999aa9abbbbbb9988881111',
  '1111888b79abba9abbcccbac88881111',
  '1111888ed9abba9bbbbccbac88881111',
  '1111888899abb99bbabccbae88881111',
  '11118888199ba979aabbbac888811111',
  '111188888f9a999aaa9aba8888811111',
  '11118888819a9d9aaaabbb8888111111',
  '1111888888d9aaabbbbbaf8888111111',
  '1111888888779aaabbba9f8881111111',
  '11118888887279aabaa99c8881111111',
  '111188888872679aa979ab8811111111',
  '111188881g772627779ab93181111111',
  '111881036h7777799aabba4630111111',
  '111032444299979abbbcca4444251111',
  '102444444699a99abbccc34664442301',
  '344444444479aaabbcccb64664444425',
];

// Pixels to change when mouth is open (y,x → palette index 4 = black)
// Mouth is at rows 20-21, columns 12-20 (verified via pixel analysis)
export const MOUTH_OPEN: Record<string, number> = {};
for (const x of [12, 13, 14, 15, 16, 17, 18, 19]) MOUTH_OPEN[`20,${x}`] = 4;
for (const x of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) MOUTH_OPEN[`21,${x}`] = 4;
for (const x of [12, 13, 14, 15, 16, 17, 18]) MOUTH_OPEN[`22,${x}`] = 4;

function decodeChar(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 122) return code - 97 + 10;
  return 0;
}

function encodeChar(n: number): string {
  if (n < 10) return String(n);
  return String.fromCharCode(97 + n - 10);
}

/** Get the sprite grid with optional mouth-open modification */
export function getSpriteGrid(mouthOpen: boolean): string[] {
  if (!mouthOpen) return MG_GRID;
  return MG_GRID.map((row, y) => {
    let modified = false;
    const chars = row.split('');
    for (let x = 0; x < chars.length; x++) {
      const idx = MOUTH_OPEN[`${y},${x}`];
      if (idx !== undefined) {
        chars[x] = encodeChar(idx);
        modified = true;
      }
    }
    return modified ? chars.join('') : row;
  });
}

/** Stamp the sprite onto an RGB background grid at position (ox, oy) */
export function stampSprite(bg: RGB[][], grid: string[], ox: number, oy: number): void {
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const idx = decodeChar(grid[y][x]);
      if (MG_TRANSPARENT.has(idx)) continue;
      const bx = ox + x;
      const by = oy + y;
      if (by >= 0 && by < bg.length && bx >= 0 && bx < bg[0].length) {
        bg[by][bx] = MG_PALETTE[idx];
      }
    }
  }
}

// === Walking sprite (pixel guy walking) ===
// Same palette as flyer: 0=transparent, 1=hair, 2=coat, 3=skin
// 10 wide, 16 tall

// Walk frame 1: left leg forward
const WALK_FRAME1: string[] = [
  '....11....',
  '...1111...',
  '...1331...',
  '...3333...',
  '...2222...',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222..22.',
  '..222..22.',
  '..222.22..',
  '..222.2...',
  '..22..2...',
  '..2...2...',
];

// Walk frame 2: legs together
const WALK_FRAME2: string[] = [
  '....11....',
  '...1111...',
  '...1331...',
  '...3333...',
  '...2222...',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222.22..',
  '..222.22..',
  '..222.22..',
  '..222.22..',
  '..2...2...',
];

// Walk frame 3: right leg forward
const WALK_FRAME3: string[] = [
  '....11....',
  '...1111...',
  '...1331...',
  '...3333...',
  '...2222...',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '..222222..',
  '.22..222..',
  '.22..222..',
  '..22.222..',
  '...2.222..',
  '...2..22..',
  '...2...2..',
];

const WALK_FRAMES = [WALK_FRAME1, WALK_FRAME2, WALK_FRAME3, WALK_FRAME2];

/** Draw the walking figure at position (px, py) with given scale and frame */
export function stampWalker(bg: RGB[][], px: number, py: number, scale: number, frame: number): void {
  const sprite = WALK_FRAMES[frame % WALK_FRAMES.length];
  const spriteW = sprite[0].length;
  const spriteH = sprite.length;

  for (let y = 0; y < spriteH; y++) {
    const row = sprite[y] || '';
    for (let x = 0; x < spriteW; x++) {
      const ch = row[x];
      if (!ch) continue;
      const idx = decodeChar(ch);
      if (idx === 0) continue;
      const sx = Math.floor(px + x * scale);
      const sy = Math.floor(py + y * scale);
      const sw = Math.max(1, Math.floor(scale));
      for (let dy = 0; dy < sw; dy++) {
        for (let dx = 0; dx < sw; dx++) {
          const bx = sx + dx;
          const by = sy + dy;
          if (by >= 0 && by < bg.length && bx >= 0 && bx < bg[0].length) {
            bg[by][bx] = FLY_PALETTE[idx];
          }
        }
      }
    }
  }
}

// === Flying sprite (simplified pixel guy with arms spread) ===
// 0 = transparent, 1 = hair, 2 = coat (dark navy), 3 = skin
const FLY_PALETTE: RGB[] = [
  [0, 0, 0], // 0: transparent
  [36, 33, 32], // 1: hair
  [25, 35, 55], // 2: coat (dark navy)
  [189, 140, 119], // 3: skin
];

// All frames are 12 wide, 14 tall for uniform indexing
// 0=transparent, 1=hair, 2=coat, 3=skin

// Frame 1: T-pose (arms level)
const FLY_FRAME1: string[] = [
  '....11......',
  '...1111.....',
  '...1331.....',
  '...3333.....',
  '.2.3333.2...',
  '2222222222..',
  '.2.3333.2...',
  '...2222.....',
  '...2222.....',
  '...2222.....',
  '...2222.....',
  '...2..2.....',
  '...2..2.....',
  '............',
];

// Frame 2: arms up (ascending)
const FLY_FRAME2: string[] = [
  '1........1..',
  '11......11..',
  '.11....11...',
  '..133331....',
  '...33333....',
  '...22222....',
  '...22222....',
  '...22222....',
  '...22222....',
  '...22222....',
  '...22222....',
  '...2..2.....',
  '...2..2.....',
  '............',
];

// Frame 3: diving (arms back)
const FLY_FRAME3: string[] = [
  '............',
  '....11......',
  '...1331.....',
  '..333333....',
  '.222222222..',
  '..2222222...',
  '...22222....',
  '...22222....',
  '...22222....',
  '...22222....',
  '...22222....',
  '...2..2.....',
  '...2..2.....',
  '............',
];

const FLY_FRAMES = [FLY_FRAME1, FLY_FRAME2, FLY_FRAME3, FLY_FRAME1];

/** Draw the flying figure at position (px, py) with given scale and frame.
 *  Uses the actual MG face sprite scaled down so Michael is recognizable as he flies. */
export function stampFlyer(bg: RGB[][], px: number, py: number, scale: number, frame: number): void {
  const sprite = FLY_FRAMES[frame % FLY_FRAMES.length];
  const spriteW = sprite[0].length;
  const spriteH = sprite.length;

  for (let y = 0; y < spriteH; y++) {
    const row = sprite[y] || '';
    for (let x = 0; x < spriteW; x++) {
      const ch = row[x];
      if (!ch) continue;
      const idx = decodeChar(ch);
      if (idx === 0) continue; // transparent
      const sx = Math.floor(px + x * scale);
      const sy = Math.floor(py + y * scale);
      const sw = Math.max(1, Math.floor(scale));
      for (let dy = 0; dy < sw; dy++) {
        for (let dx = 0; dx < sw; dx++) {
          const bx = sx + dx;
          const by = sy + dy;
          if (by >= 0 && by < bg.length && bx >= 0 && bx < bg[0].length) {
            bg[by][bx] = FLY_PALETTE[idx];
          }
        }
      }
    }
  }
}

/** Draw the actual MG face sprite scaled, for the departure scene.
 *  Stamps the real face sprite (with arms added as coat pixels) onto the grid. */
export function stampFlyingMG(bg: RGB[][], px: number, py: number, scale: number, _frame: number): void {
  const grid = getSpriteGrid(false);
  // Add coat arms on the sides of the face sprite for the flying pose
  // The face is 32 wide; we extend with coat pixels on rows 10-20
  const _flyerW = Math.floor(SPRITE_W * scale) + Math.floor(10 * scale);
  const _flyerH = Math.floor(SPRITE_H * scale) + Math.floor(14 * scale);
  const offsetX = Math.floor(5 * scale);
  const offsetY = Math.floor(14 * scale);

  // First draw coat arms (T-pose) behind the face
  const coatColor: RGB = [25, 35, 55];
  const armLen = Math.floor(5 * scale);
  const armY = py + Math.floor(16 * scale);
  // Arms extend from body
  for (let i = 0; i < armLen; i++) {
    // Left arm
    const lx = px + offsetX - i - 1;
    // Right arm
    const rx = px + offsetX + Math.floor(SPRITE_W * scale) + i;
    for (let dy = 0; dy < Math.max(1, Math.floor(2 * scale)); dy++) {
      if (armY + dy >= 0 && armY + dy < bg.length) {
        if (lx >= 0 && lx < bg[0].length) bg[armY + dy][lx] = coatColor;
        if (rx >= 0 && rx < bg[0].length) bg[armY + dy][rx] = coatColor;
      }
    }
  }

  // Draw the face sprite scaled
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const ch = grid[y][x];
      if (!ch) continue;
      const idx = decodeChar(ch);
      if (MG_TRANSPARENT.has(idx)) continue;
      const sx = Math.floor(px + offsetX + x * scale);
      const sy = Math.floor(py + offsetY + y * scale);
      const sw = Math.max(1, Math.floor(scale));
      for (let dy = 0; dy < sw; dy++) {
        for (let dx = 0; dx < sw; dx++) {
          const bx = sx + dx;
          const by = sy + dy;
          if (by >= 0 && by < bg.length && bx >= 0 && bx < bg[0].length) {
            bg[by][bx] = MG_PALETTE[idx];
          }
        }
      }
    }
  }

  // Draw coat body below the face
  const coatY = py + offsetY + Math.floor(SPRITE_H * scale);
  const coatW = Math.floor(SPRITE_W * scale * 0.6);
  const coatStartX = px + offsetX + Math.floor(SPRITE_W * scale * 0.2);
  for (let dy = 0; dy < Math.floor(10 * scale); dy++) {
    for (let dx = 0; dx < coatW; dx++) {
      const bx = coatStartX + dx;
      const by = coatY + dy;
      if (by >= 0 && by < bg.length && bx >= 0 && bx < bg[0].length) {
        bg[by][bx] = coatColor;
      }
    }
  }
}
