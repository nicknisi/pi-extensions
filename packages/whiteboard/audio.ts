/** Audio capture via subprocess (sox/ffmpeg) — terminal-friendly, no browser needed. */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Start recording audio from the default microphone, returning a PCM16 24kHz mono stream. */
export function startRecording(onData: (chunk: Buffer) => void): ChildProcessByStdio<null, Readable, Readable> {
  // macOS: sox rec | ffmpeg -f avfoundation
  // Linux: arecord
  // We use ffmpeg for cross-platform support
  let cmd: string;
  let args: string[];

  if (process.platform === 'darwin') {
    // ffmpeg with AVFoundation on macOS: ":0" = default audio input
    cmd = 'ffmpeg';
    args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'avfoundation',
      '-i',
      ':0',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'rawvideo', // raw output, no container headers
      'pipe:1',
    ];
  } else if (process.platform === 'linux') {
    // arecord on Linux
    cmd = 'arecord';
    args = ['-f', 'S16_LE', '-r', '24000', '-c', '1', '-t', 'raw'];
  } else {
    // ffmpeg fallback (Windows DShow or other)
    cmd = 'ffmpeg';
    args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'dshow',
      '-i',
      'audio=Microphone',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'rawvideo',
      'pipe:1',
    ];
  }

  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout.on('data', onData);

  proc.stderr.on('data', (data: Buffer) => {
    // Log stderr but don't fail — ffmpeg writes warnings
    const msg = data.toString().trim();
    if (msg) console.warn(`whiteboard audio: ${msg}`);
  });

  return proc;
}

/** Stop a recording process cleanly. */
export function stopRecording(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('close', () => {
      resolve(Buffer.concat(chunks));
    });
    try {
      proc.kill('SIGINT');
    } catch {
      // Already dead
    }
  });
}

/** Check if a recording binary is available. */
export async function checkAudioTool(): Promise<string | null> {
  const tool = process.platform === 'linux' ? 'arecord' : 'ffmpeg';
  return new Promise((resolve) => {
    const proc = spawn('which', [tool], { stdio: 'ignore' });
    proc.on('close', (code) => {
      resolve(code === 0 ? tool : null);
    });
    proc.on('error', () => resolve(null));
  });
}
