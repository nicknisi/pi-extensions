/**
 * /mg — File Completion Animation
 *
 * A Severance-inspired 100% completion animation featuring a pixelated
 * Michael Grinich instead of Kier Eagan. Plays an animated, audible
 * sequence: MDR grid → 100% burst → landscape reveal → Michael's
 * address → the departure → finale.
 *
 * Usage: /mg [name]
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import type { ChildProcess } from 'node:child_process';
import type { RGB } from './sprite.ts';
import { getSpriteGrid, stampFlyer, stampWalker, MG_TRANSPARENT, MG_PALETTE } from './sprite.ts';
import { playTone, playNoise, playFanfare, playWhoosh, playClick, speak, killProc } from './sound.ts';

// === Constants ===

const TICK_MS = 50; // 20fps

// Phase timings (ms)
const T_MDR_END = 2500;
const T_BURST_END = 3500;
const T_LANDSCAPE_END = 4500;
const T_WALK_END = 6500; // pixel guy walks in
const T_ADDRESS_START = T_WALK_END;
const T_ADDRESS_END = 26000; // fallback if `say` doesn't finish
const T_DEPARTURE_END = 30000;
const T_FINALE_END = 33000;

const SPRITE_W = 32;
const SPRITE_H = 32;

// === Helpers ===

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Render an RGB pixel grid to terminal lines using half-block characters */
function renderColorGrid(grid: RGB[][]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    // Rows hoisted once: y and x are bounded by the grid dimensions.
    const rowTop = grid[y]!;
    const rowBot = y + 1 < grid.length ? grid[y + 1]! : null;
    for (let x = 0; x < grid[0]!.length; x++) {
      const top = rowTop[x]!;
      const bot = rowBot ? rowBot[x]! : null;
      if (!bot) {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m▀`;
      } else if (top[0] === bot[0] && top[1] === bot[1] && top[2] === bot[2]) {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m█`;
      } else {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]};48;2;${bot[0]};${bot[1]};${bot[2]}m▀`;
      }
    }
    line += '\x1b[0m';
    lines.push(line);
  }
  return lines;
}

/** Center lines horizontally in the given width */
function centerLines(lines: string[], width: number): string[] {
  // Calculate visible width of first line (strip ANSI)
  const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const maxLen = Math.max(...lines.map(visibleLen));
  const pad = Math.max(0, Math.floor((width - maxLen) / 2));
  return lines.map((l) => ' '.repeat(pad) + l);
}

// === Landscape generation ===

function generateLandscape(pw: number, ph: number): RGB[][] {
  const grid: RGB[][] = [];

  for (let y = 0; y < ph; y++) {
    const row: RGB[] = [];
    const yr = y / ph;

    for (let x = 0; x < pw; x++) {
      const xr = x / pw;
      let color: RGB;

      // Sky gradient (sunset)
      if (yr < 0.25) {
        color = lerpRGB([18, 8, 38], [55, 18, 75], yr / 0.25);
      } else if (yr < 0.45) {
        color = lerpRGB([55, 18, 75], [160, 55, 95], (yr - 0.25) / 0.2);
      } else if (yr < 0.6) {
        color = lerpRGB([160, 55, 95], [230, 140, 85], (yr - 0.45) / 0.15);
      } else if (yr < 0.72) {
        color = lerpRGB([230, 140, 85], [248, 215, 130], (yr - 0.6) / 0.12);
      } else {
        color = [248, 215, 130];
      }

      // Mountains
      const peaks = [
        { cx: 0.12, ch: 0.32, cw: 0.1 },
        { cx: 0.3, ch: 0.42, cw: 0.14 },
        { cx: 0.52, ch: 0.5, cw: 0.16 },
        { cx: 0.72, ch: 0.38, cw: 0.12 },
        { cx: 0.9, ch: 0.35, cw: 0.1 },
      ];

      for (const m of peaks) {
        const dist = Math.abs(xr - m.cx);
        if (dist < m.cw) {
          const mountainH = m.ch * (1 - (dist / m.cw) ** 1.5);
          const mountainTop = 1 - mountainH - 0.28;
          if (yr > mountainTop && yr < 0.72) {
            const isSnow = dist < m.cw * 0.2 && yr < mountainTop + 0.04;
            color = isSnow ? [235, 230, 240] : [42, 22, 55];
          }
        }
      }

      // Clouds (bottom area)
      if (yr > 0.72) {
        const n = (Math.sin(x * 0.15 + y * 0.3) * Math.cos(x * 0.4 + y * 0.1) + 1) / 2;
        const cloudT = clamp((n - 0.35) / 0.3, 0, 1);
        color = lerpRGB([195, 190, 220], [245, 242, 248], cloudT);
      }

      // Cliff (left side)
      if (xr < 0.1 && yr > 0.62) {
        const cliffNoise = Math.sin(y * 0.4) * 0.015;
        const cliffEdge = 0.07 + cliffNoise;
        if (xr < cliffEdge) {
          color = [85, 62, 42];
        } else if (xr < cliffEdge + 0.015) {
          color = [55, 42, 28];
        }
      }

      row.push(color);
    }
    grid.push(row);
  }

  return grid;
}

// === MDR Grid rendering ===

function renderMDR(width: number, height: number, progress: number, tick: number): string[] {
  const lines: string[] = [];
  const green = '\x1b[38;2;0;200;80m';
  const greenDim = '\x1b[38;2;0;130;50m';
  const greenBright = '\x1b[38;2;80;255;120m';
  const reset = '\x1b[0m';
  const bg = '\x1b[48;2;8;12;8m';

  // Fill with random numbers
  const numCols = Math.floor((width - 2) / 3);
  const numRows = Math.max(8, Math.min(height - 6, 16));

  for (let r = 0; r < numRows; r++) {
    let line = bg;
    for (let c = 0; c < numCols; c++) {
      const seed = (tick * 7 + r * 31 + c * 17) % 1000;
      const num = ((Math.floor(Math.sin(seed) * 1000) % 100) + 100) % 100;
      const isHighlighted = (tick + r + c) % 13 === 0;
      const color = isHighlighted ? greenBright : c % 3 === 0 ? greenDim : green;
      line += `${color}${String(num).padStart(2, '0')} `;
    }
    line += reset;
    lines.push(line);
  }

  // Progress bar
  lines.push('');
  const barWidth = Math.min(40, width - 20);
  const filled = Math.floor(barWidth * progress);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const pct = Math.floor(progress * 100);
  const barLine = `${bg}${green} REFINING: ${greenBright}[${bar}] ${String(pct).padStart(3)}%${reset}`;
  lines.push(barLine);
  lines.push('');

  // Bin numbers (like the show)
  const bins = '  OH   WO   FC   DR   GA';
  const binLine = `${bg}${greenDim}${bins}    WorkOS${reset}`;
  lines.push(binLine);

  return centerLines(lines, width);
}

// === 100% big text ===

const FONT: Record<string, string[]> = {
  '1': ['  ██  ', ' ███  ', '  ██  ', '  ██  ', '  ██  ', '  ██  ', '██████'],
  '0': [' ████ ', '█  ██ ', '█  ███', '█ █ ██', '███  █', '██  █ ', ' ████ '],
  '%': ['██  ██', '██ ██ ', '  ██  ', '  ██  ', '  ██  ', ' ██ ██', '██  ██'],
};

function renderBigText(text: string, r: number, g: number, b: number): string[] {
  const chars = text.split('');
  const lines: string[] = [];
  const color = `\x1b[38;2;${r};${g};${b}m`;
  const reset = '\x1b[0m';

  for (let row = 0; row < 7; row++) {
    let line = '';
    for (const ch of chars) {
      const glyph = FONT[ch] || FONT['0']!;
      line += color + glyph[row] + reset;
    }
    lines.push(line);
  }
  return lines;
}

// === Explosion particles ===

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: RGB;
  life: number;
}

function createExplosion(pw: number, ph: number): Particle[] {
  const particles: Particle[] = [];
  const colors: RGB[] = [
    [255, 100, 100],
    [100, 255, 100],
    [100, 100, 255],
    [255, 200, 50],
    [255, 50, 200],
    [50, 255, 200],
    [255, 255, 100],
    [200, 100, 255],
  ];
  const cx = pw / 2;
  const cy = ph / 2;
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * Math.PI * 2 + Math.random() * 0.3;
    const speed = 0.3 + Math.random() * 0.8;
    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.6,
      color: colors[i % colors.length]!,
      life: 1.0,
    });
  }
  return particles;
}

function renderExplosion(particles: Particle[], pw: number, ph: number, progress: number): RGB[][] {
  const grid: RGB[][] = [];
  const bg: RGB = [8, 8, 16];
  for (let y = 0; y < ph; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < pw; x++) {
      row.push([...bg]);
    }
    grid.push(row);
  }
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.life = 1 - progress;
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    if (px >= 0 && px < pw && py >= 0 && py < ph && p.life > 0) {
      grid[py]![px] = [
        Math.floor(p.color[0] * p.life),
        Math.floor(p.color[1] * p.life),
        Math.floor(p.color[2] * p.life),
      ];
    }
  }
  return grid;
}

// === Monologue ===

const MONOLOGUE = (name: string) =>
  `I knew you could do it, ${name}. ... Even in your darkest moments, I could see you arriving here. ... In refining your code, you have brought glory to this company and to me. ... I, Michael Grinich, love you. ... But now I must away, for there are other developers who need me around the world. ... Goodbye, ${name}. ... And thank you.`;

const SUBTITLES = (name: string): { t: number; text: string }[] => [
  { t: 0, text: `I knew you could do it, ${name}.` },
  { t: 3500, text: `Even in your darkest moments, I could see you arriving here.` },
  { t: 7500, text: `In refining your code, you have brought glory to this company and to me.` },
  { t: 12500, text: `I, Michael Grinich, love you.` },
  { t: 16000, text: `But now I must away, for there are others who need me around the world.` },
  { t: 20000, text: `Goodbye, ${name}. And thank you.` },
];

// === Animation Component ===

class HundredPercentComponent {
  private startTime = Date.now();
  private interval: ReturnType<typeof setInterval> | null = null;
  private procs: (ChildProcess | null)[] = [];
  private onClose: () => void;
  private tui: { requestRender: () => void };
  private name: string;
  private mouthOpen = false;
  private sayProc: ChildProcess | null = null;
  private sayDone = false;
  private soundsTriggered = new Set<string>();
  private particles: Particle[] = [];
  private cachedLandscape: RGB[][] | null = null;
  private cachedLandscapeW = 0;
  private cachedLandscapeH = 0;
  private disposed = false;
  private clickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(tui: { requestRender: () => void }, onClose: () => void, name: string) {
    this.tui = tui;
    this.onClose = onClose;
    this.name = name;

    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  private elapsed(): number {
    return Date.now() - this.startTime;
  }

  private tick(): void {
    if (this.disposed) return;
    const t = this.elapsed();
    this.tui.requestRender();

    // Trigger sounds at specific times
    if (!this.soundsTriggered.has('first_click') && t > 100) {
      this.soundsTriggered.add('first_click');
      // Start rapid clicks during MDR phase
      this.clickTimer = setInterval(
        () => {
          if (this.disposed) return;
          const e = this.elapsed();
          if (e > T_MDR_END) {
            if (this.clickTimer) {
              clearInterval(this.clickTimer);
              this.clickTimer = null;
            }
            return;
          }
          const progress = e / T_MDR_END;
          const freq = 800 + progress * 600;
          this.procs.push(playClick(freq, 30));
        },
        Math.max(30, 200 - (t / T_MDR_END) * 150),
      );
    }

    if (!this.soundsTriggered.has('explosion') && t > T_MDR_END) {
      this.soundsTriggered.add('explosion');
      this.procs.push(playNoise(600, 0.25));
      this.procs.push(playTone(80, 400, 0.4));
      this.particles = createExplosion(50, 20);
    }

    if (!this.soundsTriggered.has('fanfare') && t > T_BURST_END) {
      this.soundsTriggered.add('fanfare');
      this.procs.push(playFanfare());
    }

    if (!this.soundsTriggered.has('speak') && t > T_ADDRESS_START) {
      this.soundsTriggered.add('speak');
      this.sayProc = speak(MONOLOGUE(this.name), 120, () => {
        this.sayDone = true;
      });
      this.procs.push(this.sayProc);

      // Mouth animation - toggle every 180ms
      const mouthTimer = setInterval(() => {
        if (this.disposed || this.sayDone) {
          clearInterval(mouthTimer);
          this.mouthOpen = false;
          return;
        }
        this.mouthOpen = !this.mouthOpen;
      }, 180);
    }

    if (!this.soundsTriggered.has('whoosh') && (this.sayDone || t > T_ADDRESS_END)) {
      this.soundsTriggered.add('whoosh');
      this.procs.push(playWhoosh());
    }

    if (!this.soundsTriggered.has('finale') && t > T_DEPARTURE_END) {
      this.soundsTriggered.add('finale');
      this.procs.push(playFanfare());
      this.procs.push(playTone(523, 600, 0.3));
    }

    // Auto-end
    if (t > T_FINALE_END + 2000) {
      this.dispose();
      this.onClose();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || data === 'q' || data === 'Q' || data === '\x03') {
      this.dispose();
      this.onClose();
    }
  }

  invalidate(): void {
    this.cachedLandscape = null;
  }

  render(width: number): string[] {
    if (this.disposed) return [''];

    const t = this.elapsed();

    // Determine terminal area (pixel dimensions for half-block rendering)
    // Each terminal char = 1 pixel wide, 2 pixels tall (half-block)
    const pw = Math.min(width, 80);
    const ph = 30; // 30 pixels = 15 terminal lines
    const contentWidth = pw; // visible chars per line

    // Phase 1: MDR Grid
    if (t < T_MDR_END) {
      const progress = t / T_MDR_END;
      // Ease the progress (slow start, fast end)
      const eased = progress < 0.8 ? progress * 0.8 : 0.64 + (progress - 0.8) * 1.8;
      return renderMDR(contentWidth, ph, clamp(eased, 0, 1), Math.floor(t / TICK_MS));
    }

    // Phase 2: 100% Burst
    if (t < T_BURST_END) {
      const burstProgress = (t - T_MDR_END) / (T_BURST_END - T_MDR_END);
      if (burstProgress < 0.3) {
        // Show "100%" text
        const glow = 0.7 + 0.3 * Math.sin(t * 0.02);
        const r = Math.floor(255 * glow);
        const g = Math.floor(220 * glow);
        const b = Math.floor(100 * glow);
        const text = renderBigText('100%', r, g, b);
        return centerLines(text, contentWidth);
      } else {
        // Explosion
        const grid = renderExplosion(this.particles, pw, ph, (burstProgress - 0.3) / 0.7);
        return centerLines(renderColorGrid(grid), contentWidth);
      }
    }

    // Phase 3: Landscape Reveal
    if (t < T_LANDSCAPE_END) {
      const revealProgress = (t - T_BURST_END) / (T_LANDSCAPE_END - T_BURST_END);
      const landscape = this.getLandscape(pw, ph);
      // Paint in from top to bottom
      const cutoff = Math.floor(ph * revealProgress);
      const grid: RGB[][] = [];
      for (let y = 0; y < ph; y++) {
        const row: RGB[] = [];
        for (let x = 0; x < pw; x++) {
          if (y < cutoff) {
            row.push(landscape[y]![x]!);
          } else {
            row.push([8, 8, 16]);
          }
        }
        grid.push(row);
      }
      return centerLines(renderColorGrid(grid), contentWidth);
    }

    // Phase 3.5: Pixel guy walks in on the cliff
    if (t < T_WALK_END) {
      const walkProgress = (t - T_LANDSCAPE_END) / (T_WALK_END - T_LANDSCAPE_END);
      return this.renderWalkIn(pw, ph, contentWidth, walkProgress, t);
    }

    // Phase 4: Michael's Address
    // Ensure at least 5s of departure time after speaking finishes
    const addressEnd = this.sayDone
      ? Math.min(t, Math.max(T_ADDRESS_START + 1000, T_DEPARTURE_END - 5000))
      : T_ADDRESS_END;
    if (t < addressEnd) {
      return this.renderAddress(pw, ph, contentWidth, t - T_ADDRESS_START);
    }

    // Phase 5: The Departure
    if (t < T_DEPARTURE_END) {
      const depProgress = (t - addressEnd) / (T_DEPARTURE_END - addressEnd);
      return this.renderDeparture(pw, ph, contentWidth, depProgress, t);
    }

    // Phase 6: Finale
    if (t < T_FINALE_END) {
      const finProgress = (t - T_DEPARTURE_END) / (T_FINALE_END - T_DEPARTURE_END);
      return this.renderFinale(contentWidth, finProgress, t);
    }

    return [''];
  }

  private getLandscape(pw: number, ph: number): RGB[][] {
    if (!this.cachedLandscape || this.cachedLandscapeW !== pw || this.cachedLandscapeH !== ph) {
      this.cachedLandscape = generateLandscape(pw, ph);
      this.cachedLandscapeW = pw;
      this.cachedLandscapeH = ph;
    }
    return this.cachedLandscape;
  }

  private renderWalkIn(pw: number, ph: number, contentWidth: number, progress: number, t: number): string[] {
    const landscape = this.getLandscape(pw, ph);
    const grid = landscape.map((row) => row.map((c) => [...c] as RGB));

    // Pixel guy walks in from the left, stops at center
    const startX = -2;
    const endX = Math.floor(pw * 0.4) - 5;
    const x = lerp(startX, endX, progress);
    const y = Math.floor(ph * 0.55);

    // Walk animation: cycle through frames
    const frame = Math.floor(t / 180) % 4;
    stampWalker(grid, Math.floor(x), y, 1.0, frame);

    return centerLines(renderColorGrid(grid), contentWidth);
  }

  private renderAddress(pw: number, ph: number, contentWidth: number, at: number): string[] {
    const landscape = this.getLandscape(pw, ph);
    // Copy landscape
    const grid = landscape.map((row) => row.map((c) => [...c] as RGB));

    // Fade in the face sprite during first 500ms
    const fadeIn = clamp(at / 500, 0, 1);
    if (fadeIn > 0) {
      const sprite = getSpriteGrid(this.mouthOpen);
      const ox = Math.floor((pw - SPRITE_W) / 2);
      const oy = Math.floor((ph - SPRITE_H) / 2 - 2); // slightly above center

      // Stamp sprite with fade
      const palette = MG_PALETTE;
      for (let y = 0; y < sprite.length; y++) {
        for (let x = 0; x < sprite[y]!.length; x++) {
          const idx = (() => {
            const code = sprite[y]![x]!.charCodeAt(0);
            if (code >= 48 && code <= 57) return code - 48;
            if (code >= 97 && code <= 122) return code - 97 + 10;
            return 0;
          })();
          if (MG_TRANSPARENT.has(idx)) continue;
          const bx = ox + x;
          const by = oy + y;
          if (by >= 0 && by < grid.length && bx >= 0 && bx < grid[0]!.length) {
            const spriteColor = palette[idx]!;
            const bgColor = grid[by]![bx]!;
            grid[by]![bx] = lerpRGB(bgColor, spriteColor, fadeIn);
          }
        }
      }
    }

    const gridLines = renderColorGrid(grid);

    // Subtitles
    const subs = SUBTITLES(this.name);
    let subtitle = '';
    for (const s of subs) {
      if (at >= s.t) subtitle = s.text;
    }
    if (subtitle) {
      const subColor = '\x1b[38;2;240;240;250m';
      const reset = '\x1b[0m';
      const subLine = `${subColor}${subtitle}${reset}`;
      gridLines.push('');
      gridLines.push(centerLines([subLine], contentWidth)[0]!);
    }

    return centerLines(gridLines, contentWidth);
  }

  private renderDeparture(pw: number, ph: number, contentWidth: number, progress: number, t: number): string[] {
    const landscape = this.getLandscape(pw, ph);
    const grid = landscape.map((row) => row.map((c) => [...c] as RGB));

    const tt = progress;

    // Start on the cliff (left), fly up and right in an S-curve, shrink into distance
    const startX = pw * 0.08;
    const startY = ph * 0.6;
    const endX = pw * 0.88;
    const endY = ph * 0.08;

    // X: steady rightward
    const x = lerp(startX, endX, tt);
    // Y: S-curve arc — rise, dip, rise again
    const baseY = lerp(startY, endY, tt);
    const arc = Math.sin(tt * Math.PI * 2) * ph * 0.1;
    const y = baseY - arc;

    // Scale: start big, stay visible, then shrink rapidly at the end
    // Use ease-out-cubic so he stays large for most of the flight
    const scale = lerp(1.2, 0.05, Math.pow(tt, 1.5));

    // Frame: cycle through poses for wing-flapping effect
    const frame = Math.floor(t / 250) % 4;

    // Only render if big enough to see
    if (scale > 0.06) {
      stampFlyer(grid, Math.floor(x), Math.floor(y), scale, frame);
    }

    // Motion trail — faint pixels behind the flyer
    if (tt > 0.05 && tt < 0.95) {
      const trailColor: RGB = [80, 90, 120];
      for (let i = 1; i <= 5; i++) {
        const trailT = Math.max(0, tt - i * 0.025);
        const tx = Math.floor(lerp(startX, endX, trailT));
        const ty = Math.floor(lerp(startY, endY, trailT) - Math.sin(trailT * Math.PI * 2) * ph * 0.1);
        if (ty >= 0 && ty < grid.length && tx >= 0 && tx < grid[0]!.length) {
          // Fade trail by distance
          const alpha = 1 - i / 5;
          const orig = grid[ty]![tx]!;
          grid[ty]![tx] = [
            Math.round(lerp(orig[0], trailColor[0], alpha * 0.5)),
            Math.round(lerp(orig[1], trailColor[1], alpha * 0.5)),
            Math.round(lerp(orig[2], trailColor[2], alpha * 0.5)),
          ];
        }
      }
    }

    return centerLines(renderColorGrid(grid), contentWidth);
  }

  private renderFinale(contentWidth: number, progress: number, t: number): string[] {
    const lines: string[] = [];

    // Fade in "100% COMPLETE"
    const fadeIn = clamp(progress * 3, 0, 1);
    const glow = 0.7 + 0.3 * Math.sin(t * 0.005);
    const r = Math.floor(255 * glow * fadeIn);
    const g = Math.floor(220 * glow * fadeIn);
    const b = Math.floor(100 * glow * fadeIn);

    lines.push('');
    lines.push('');

    const text = renderBigText('100%', r, g, b);
    const completeColor = `\x1b[38;2;${r};${g};${b}m`;
    const reset = '\x1b[0m';

    // Add "COMPLETE" below the big "100%"
    for (let i = 0; i < text.length; i++) {
      lines.push(text[i]!);
    }
    lines.push('');
    const completeLine = `${completeColor}     C O M P L E T E${reset}`;
    lines.push(completeLine);
    lines.push('');

    // File info
    const info = `\x1b[38;2;160;160;180m  File: ${this.name.padEnd(12)} │ Status: REFINED │ WorkOS${reset}`;
    lines.push(info);

    // Fade out at the end
    if (progress > 0.7) {
      const fadeOut = 1 - (progress - 0.7) / 0.3;
      if (fadeOut < 0.1) return [''];
    }

    return centerLines(lines, contentWidth);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.clickTimer) {
      clearInterval(this.clickTimer);
      this.clickTimer = null;
    }
    for (const p of this.procs) killProc(p);
    killProc(this.sayProc);
  }
}

// === Extension ===

export default function (pi: ExtensionAPI) {
  pi.registerCommand('mg', {
    description: '100% File Completion Animation (Severance-style, starring Michael Grinich)',

    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('100% animation requires interactive mode', 'error');
        return;
      }

      const name = args.trim() || process.env.USER?.trim() || 'WorkOS employee';

      await ctx.ui.custom((tui, _theme, _kb, done) => {
        return new HundredPercentComponent(tui, () => done(undefined), name);
      });
    },
  });
}
