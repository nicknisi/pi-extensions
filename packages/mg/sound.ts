/**
 * Sound utilities for the 100% animation.
 * Generates WAV data in-memory and plays via afplay (macOS).
 * Uses `say` for the spoken monologue.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SAMPLE_RATE = 44100;

function generateWav(samples: Float32Array): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.floor(v * 32767), 44 + i * 2);
  }
  return buf;
}

function playWav(buf: Buffer): ChildProcess | null {
  try {
    const file = join(tmpdir(), `pi100_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    writeFileSync(file, buf);
    const proc = spawn('afplay', [file], { stdio: 'ignore' });
    proc.on('exit', () => {
      try {
        unlinkSync(file);
      } catch {}
    });
    return proc;
  } catch {
    return null;
  }
}

/** Simple sine wave tone with attack/decay envelope */
export function playTone(freq: number, durationMs: number, volume = 0.3): ChildProcess | null {
  const n = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(n);
  const attack = Math.floor(SAMPLE_RATE * 0.01);
  const decay = Math.floor(SAMPLE_RATE * 0.05);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    let env = 1;
    if (i < attack) env = i / attack;
    if (i > n - decay) env = (n - i) / decay;
    samples[i] = Math.sin(2 * Math.PI * freq * t) * env * volume;
  }
  return playWav(generateWav(samples));
}

/** White noise burst (explosion sound) */
export function playNoise(durationMs: number, volume = 0.2): ChildProcess | null {
  const n = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(n);
  const decay = Math.floor(SAMPLE_RATE * 0.3);
  for (let i = 0; i < n; i++) {
    const env = i < decay ? 1 - i / decay : 0.1;
    samples[i] = (Math.random() * 2 - 1) * env * volume;
  }
  return playWav(generateWav(samples));
}

/** Triumphant ascending fanfare */
export function playFanfare(): ChildProcess | null {
  const notes = [262, 330, 392, 523]; // C E G C
  const noteMs = 180;
  const n = Math.floor(((notes.length * noteMs) / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(n);
  const noteLen = Math.floor((noteMs / 1000) * SAMPLE_RATE);
  for (let ni = 0; ni < notes.length; ni++) {
    const freq = notes[ni];
    const offset = ni * noteLen;
    for (let i = 0; i < noteLen && offset + i < n; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.min(1, i / (SAMPLE_RATE * 0.02)) * Math.min(1, (noteLen - i) / (SAMPLE_RATE * 0.05));
      samples[offset + i] =
        (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2 * t)) * env * 0.25;
    }
  }
  return playWav(generateWav(samples));
}

/** Frequency sweep (whoosh sound) */
export function playWhoosh(): ChildProcess | null {
  const durationMs = 800;
  const n = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / n;
    const freq = 2000 - 1800 * progress; // high to low
    const env = Math.sin(Math.PI * progress) * 0.15;
    samples[i] = (Math.sin(2 * Math.PI * freq * t) + (Math.random() * 2 - 1) * 0.5) * env;
  }
  return playWav(generateWav(samples));
}

/** Quick beep for MDR counting */
export function playClick(freq = 1200, durationMs = 40): ChildProcess | null {
  return playTone(freq, durationMs, 0.15);
}

/** Speak the monologue using macOS `say` — slow and dramatic */
export function speak(text: string, rate = 120, onDone?: () => void): ChildProcess | null {
  try {
    // Daniel = deep dramatic British male voice, slow rate for gravitas
    const args = ['-v', 'Daniel', '-r', String(rate)];
    const proc = spawn('say', [...args, text], { stdio: 'ignore' });
    proc.on('exit', () => onDone?.());
    return proc;
  } catch {
    onDone?.();
    return null;
  }
}

/** Kill a child process safely */
export function killProc(proc: ChildProcess | null): void {
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGKILL');
    } catch {}
  }
}
