/** Descriptor-relative, symlink-safe filesystem operations for the relay store. Pi-free. */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import koffi from 'koffi';

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  throw new Error(`Relay filesystem operations are unsupported on ${process.platform}`);
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const CLOEXEC = process.platform === 'darwin' ? 0x01000000 : 0x00080000;
const READ_DIRECTORY_FLAGS = fs.constants.O_RDONLY | NOFOLLOW | DIRECTORY | CLOEXEC;
const AT_REMOVEDIR = 0x80;

function loadLibc(): ReturnType<typeof koffi.load> {
  const candidates =
    process.platform === 'darwin'
      ? ['/usr/lib/libSystem.B.dylib']
      : [
          'libc.so.6',
          `/lib/libc.musl-${process.arch === 'arm64' ? 'aarch64' : process.arch}.so.1`,
          `/usr/lib/libc.musl-${process.arch === 'arm64' ? 'aarch64' : process.arch}.so.1`,
        ];
  for (const candidate of candidates) {
    try {
      return koffi.load(candidate);
    } catch {
      // try the next libc name (glibc first, then musl)
    }
  }
  throw new Error(`Relay could not load libc on ${process.platform}/${process.arch}`);
}

const libc = loadLibc();
const nativeOpenAt = libc.func('int openat(int, const char *, int, ...)');
const nativeMkdirAt = libc.func('int mkdirat(int, const char *, uint32_t)');
const nativeUnlinkAt = libc.func('int unlinkat(int, const char *, int)');
const nativeRenameAt = libc.func('int renameat(int, const char *, int, const char *)');
const nativeDup = libc.func('int dup(int)');
const nativeFdOpenDir = libc.func('void *fdopendir(int)');
const nativeReadDir = libc.func('void *readdir(void *)');
const nativeCloseDir = libc.func('int closedir(void *)');
const nativeStrError = libc.func('const char *strerror(int)');
const errnoNames = new Map(Object.entries(koffi.os.errno).map(([name, value]) => [value, name]));

/** An existing relay path is unsafe to traverse or is not the expected type. */
export class RelayFilesystemError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RelayFilesystemError';
  }
}

export function rethrowFilesystemError(error: unknown): void {
  if (error instanceof RelayFilesystemError) throw error;
}

export function assertPathSegment(segment: string, label = 'relay path component'): void {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new RelayFilesystemError(`Unsafe ${label}: ${segment}`);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function unsafe(message: string, cause?: unknown): never {
  throw new RelayFilesystemError(message, cause === undefined ? undefined : { cause });
}

function syscallError(syscall: string, target: string): NodeJS.ErrnoException {
  const errno = koffi.errno();
  const code = errnoNames.get(errno) ?? `ERRNO_${errno}`;
  const error = new Error(`${syscall} ${target}: ${nativeStrError(errno)}`) as NodeJS.ErrnoException;
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  error.path = target;
  return error;
}

function openAt(directoryFd: number, name: string, flags: number, mode = 0): number {
  const fd =
    flags & fs.constants.O_CREAT
      ? nativeOpenAt(directoryFd, name, flags, 'uint32_t', mode)
      : nativeOpenAt(directoryFd, name, flags);
  if (fd < 0) throw syscallError('openat', name);
  return fd;
}

function mkdirAt(directoryFd: number, name: string): void {
  if (nativeMkdirAt(directoryFd, name, 0o700) < 0) throw syscallError('mkdirat', name);
}

function unlinkAt(directoryFd: number, name: string, flags = 0): void {
  if (nativeUnlinkAt(directoryFd, name, flags) < 0) throw syscallError('unlinkat', name);
}

function renameAt(fromDirectoryFd: number, from: string, toDirectoryFd: number, to: string): void {
  if (nativeRenameAt(fromDirectoryFd, from, toDirectoryFd, to) < 0) {
    throw syscallError('renameat', `${from} -> ${to}`);
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyDirectoryFd(fd: number, label: string): fs.Stats {
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory()) unsafe(`Relay path is not a directory: ${label}`);
  return stat;
}

function isProtectedSystemPath(stat: fs.Stats): boolean {
  return stat.uid === 0 && (stat.mode & 0o022) === 0;
}

function canonicalTraversalPath(absolute: string): string {
  let candidate = absolute;
  for (let redirect = 0; redirect < 40; redirect++) {
    const parsed = path.parse(candidate);
    const components = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    let redirected = false;

    for (const [index, component] of components.entries()) {
      current = path.join(current, component);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return candidate;
        throw error;
      }

      if (stat.isSymbolicLink()) {
        if (index === components.length - 1) unsafe(`Refusing symlinked relay root: ${absolute}`);

        let canonicalTarget: string;
        let targetStat: fs.Stats;
        const parentStat = fs.statSync(path.dirname(current));
        try {
          canonicalTarget = fs.realpathSync.native(current);
          targetStat = fs.lstatSync(canonicalTarget);
        } catch (error) {
          unsafe(`Refusing unsafe system ancestor symlink: ${current}`, error);
        }
        if (
          !isProtectedSystemPath(parentStat) ||
          !isProtectedSystemPath(stat) ||
          !targetStat.isDirectory() ||
          !isProtectedSystemPath(targetStat)
        ) {
          unsafe(`Refusing user-controlled ancestor symlink: ${current}`);
        }

        candidate = path.join(canonicalTarget, ...components.slice(index + 1));
        redirected = true;
        break;
      }

      if (!stat.isDirectory()) unsafe(`Relay path is not a directory: ${current}`);
    }

    if (!redirected) return candidate;
  }
  unsafe(`Refusing relay path with too many system symlinks: ${absolute}`);
}

function openDirectoryAt(
  directoryFd: number,
  name: string,
  create: boolean,
  label: string,
  chmodExisting = false,
): number | null {
  assertPathSegment(name);
  let created = false;
  if (create) {
    try {
      mkdirAt(directoryFd, name);
      created = true;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
  }

  let fd: number;
  try {
    fd = openAt(directoryFd, name, READ_DIRECTORY_FLAGS);
  } catch (error) {
    if (!create && isErrorCode(error, 'ENOENT')) return null;
    if (isErrorCode(error, 'ELOOP') || isErrorCode(error, 'ENOTDIR')) {
      unsafe(`Refusing symlinked or non-directory relay path component: ${label}`, error);
    }
    throw error;
  }
  try {
    verifyDirectoryFd(fd, label);
    if (created || chmodExisting) {
      try {
        fs.fchmodSync(fd, 0o700);
      } catch {
        // best-effort on filesystems that support modes
      }
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export interface RelayDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const DT_DIRECTORY = 4;
const DT_REGULAR = 8;
const DT_SYMLINK = 10;

function readDirectoryFd(fd: number): RelayDirent[] {
  const duplicate = nativeDup(fd);
  if (duplicate < 0) throw syscallError('dup', String(fd));
  const directory = nativeFdOpenDir(duplicate);
  if (directory === null) {
    fs.closeSync(duplicate);
    throw syscallError('fdopendir', String(fd));
  }

  const entries: RelayDirent[] = [];
  try {
    for (;;) {
      koffi.errno(0);
      const pointer = nativeReadDir(directory);
      if (pointer === null) {
        if (koffi.errno() !== 0) throw syscallError('readdir', String(fd));
        break;
      }
      const bytes = Buffer.from(koffi.view(pointer, process.platform === 'darwin' ? 1048 : 280));
      const type = bytes[process.platform === 'darwin' ? 20 : 18]!;
      const nameOffset = process.platform === 'darwin' ? 21 : 19;
      const nameLength =
        process.platform === 'darwin'
          ? bytes.readUInt16LE(18)
          : bytes.subarray(nameOffset).indexOf(0) === -1
            ? bytes.length - nameOffset
            : bytes.subarray(nameOffset).indexOf(0);
      const name = bytes.subarray(nameOffset, nameOffset + nameLength).toString();
      if (name === '.' || name === '..') continue;
      entries.push({
        name,
        isFile: () => type === DT_REGULAR,
        isDirectory: () => type === DT_DIRECTORY,
        isSymbolicLink: () => type === DT_SYMLINK,
      });
    }
  } finally {
    nativeCloseDir(directory);
  }
  return entries;
}

function openRegularFileAt(directoryFd: number, name: string, flags: number, mode = 0): number | null {
  assertPathSegment(name, 'relay file name');
  let fd: number;
  try {
    fd = openAt(directoryFd, name, flags | NOFOLLOW | CLOEXEC, mode);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null;
    if (isErrorCode(error, 'ELOOP')) unsafe(`Refusing symlinked relay file: ${name}`, error);
    throw error;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) unsafe(`Relay path is not a regular file: ${name}`);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** A pinned directory descriptor. All child and leaf access is relative to this descriptor. */
export class RelayDirectoryHandle {
  readonly #fd: number;
  readonly #label: string;
  #closed = false;

  constructor(fd: number, label: string) {
    this.#fd = fd;
    this.#label = label;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    fs.closeSync(this.#fd);
  }

  openDirectory(name: string, create = false): RelayDirectoryHandle | null {
    this.#assertOpen();
    const label = `${this.#label}/${name}`;
    const fd = openDirectoryAt(this.#fd, name, create, label, create);
    return fd === null ? null : new RelayDirectoryHandle(fd, label);
  }

  readDirectory(): RelayDirent[] {
    this.#assertOpen();
    return readDirectoryFd(this.#fd);
  }

  readFile(fileName: string): string | null {
    this.#assertOpen();
    const fd = openRegularFileAt(this.#fd, fileName, fs.constants.O_RDONLY);
    if (fd === null) return null;
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  writeFileAtomic(fileName: string, contents: string): void {
    this.#assertOpen();
    assertPathSegment(fileName, 'relay file name');

    let temporary = '';
    let fd: number | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      temporary = `${fileName}.${randomBytes(16).toString('hex')}.tmp`;
      try {
        fd = openRegularFileAt(
          this.#fd,
          temporary,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
        break;
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
    }
    if (fd === null) throw new Error(`Could not create an exclusive relay temporary file for ${fileName}`);

    let renamed = false;
    try {
      fs.writeFileSync(fd, contents, 'utf8');
      fs.fsyncSync(fd);
      this.verifyFile(fileName);
      renameAt(this.#fd, temporary, this.#fd, fileName);
      this.sync();
      renamed = true;
    } finally {
      fs.closeSync(fd);
      if (!renamed) {
        try {
          unlinkAt(this.#fd, temporary);
        } catch {
          // best-effort cleanup of the random file created by this call
        }
      }
    }
  }

  unlinkFile(fileName: string): boolean {
    this.#assertOpen();
    const fd = openRegularFileAt(this.#fd, fileName, fs.constants.O_RDONLY);
    if (fd === null) return false;
    fs.closeSync(fd);
    try {
      unlinkAt(this.#fd, fileName);
      return true;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  fileExists(fileName: string): boolean {
    this.#assertOpen();
    const fd = openRegularFileAt(this.#fd, fileName, fs.constants.O_RDONLY);
    if (fd === null) return false;
    fs.closeSync(fd);
    return true;
  }

  verifyFile(fileName: string): void {
    this.#assertOpen();
    const fd = openRegularFileAt(this.#fd, fileName, fs.constants.O_RDONLY);
    if (fd !== null) fs.closeSync(fd);
  }

  appendFile(fileName: string, contents: string): number {
    this.#assertOpen();
    const fd = openRegularFileAt(
      this.#fd,
      fileName,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600,
    );
    if (fd === null) throw new Error(`Could not open relay file for append: ${fileName}`);
    try {
      fs.writeFileSync(fd, contents, 'utf8');
      return fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
  }

  renameFile(fromName: string, toName: string): void {
    this.#assertOpen();
    const from = openRegularFileAt(this.#fd, fromName, fs.constants.O_RDONLY);
    if (from === null) return;
    fs.closeSync(from);
    this.verifyFile(toName);
    renameAt(this.#fd, fromName, this.#fd, toName);
  }

  /** Atomically move one pinned child directory beneath another pinned directory. */
  moveDirectoryTo(name: string, target: RelayDirectoryHandle, targetName: string): RelayDirectoryHandle | null {
    this.#assertOpen();
    target.#assertOpen();
    assertPathSegment(name);
    assertPathSegment(targetName);

    const source = this.openDirectory(name);
    if (source === null) return null;
    try {
      const existing = target.openDirectory(targetName);
      if (existing !== null) {
        existing.close();
        unsafe(`Relay destination directory already exists: ${targetName}`);
      }

      const sourceStat = fs.fstatSync(source.#fd);
      renameAt(this.#fd, name, target.#fd, targetName);
      const moved = target.openDirectory(targetName);
      if (moved === null) unsafe(`Relay directory move disappeared: ${targetName}`);
      try {
        if (!sameFile(sourceStat, fs.fstatSync(moved.#fd))) {
          unsafe(`Relay directory changed during move: ${name}`);
        }
      } finally {
        moved.close();
      }
      this.sync();
      target.sync();
      return source;
    } catch (error) {
      source.close();
      throw error;
    }
  }

  /** Atomically move one regular file between pinned directories without following links. */
  moveFileTo(fileName: string, target: RelayDirectoryHandle, targetName = fileName): boolean {
    this.#assertOpen();
    target.#assertOpen();
    assertPathSegment(fileName, 'relay file name');
    assertPathSegment(targetName, 'relay file name');

    const sourceFd = openRegularFileAt(this.#fd, fileName, fs.constants.O_RDONLY);
    if (sourceFd === null) return false;
    try {
      if (target.fileExists(targetName)) return false;
      const sourceStat = fs.fstatSync(sourceFd);
      renameAt(this.#fd, fileName, target.#fd, targetName);
      const movedFd = openRegularFileAt(target.#fd, targetName, fs.constants.O_RDONLY);
      if (movedFd === null) unsafe(`Relay file move disappeared: ${targetName}`);
      try {
        if (!sameFile(sourceStat, fs.fstatSync(movedFd))) unsafe(`Relay file changed during move: ${fileName}`);
      } finally {
        fs.closeSync(movedFd);
      }
      this.sync();
      target.sync();
      return true;
    } finally {
      fs.closeSync(sourceFd);
    }
  }

  /** Remove a child directory only when it is still a real, empty directory. */
  removeEmptyDirectory(name: string): boolean {
    this.#assertOpen();
    const directory = this.openDirectory(name);
    if (directory === null) return false;
    try {
      if (directory.readDirectory().length > 0) return false;
      try {
        unlinkAt(this.#fd, name, AT_REMOVEDIR);
        this.sync();
        return true;
      } catch (error) {
        if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'ENOTEMPTY') || isErrorCode(error, 'EEXIST')) {
          return false;
        }
        throw error;
      }
    } finally {
      directory.close();
    }
  }

  sync(): void {
    this.#assertOpen();
    fs.fsyncSync(this.#fd);
  }

  removeDirectory(name: string): void {
    this.#assertOpen();
    const directory = this.openDirectory(name);
    if (directory === null) return;
    try {
      for (const entry of directory.readDirectory()) {
        if (entry.isSymbolicLink()) unsafe(`Refusing symlinked relay entry: ${entry.name}`);
        if (!entry.isFile()) unsafe(`Relay directory contains a non-file entry: ${entry.name}`);
        directory.unlinkFile(entry.name);
      }
      unlinkAt(this.#fd, name, AT_REMOVEDIR);
    } finally {
      directory.close();
    }
  }

  watch(listener: () => void): RelayWatcher {
    this.#assertOpen();
    let previous = fs.fstatSync(this.#fd).mtimeMs;
    const timer = setInterval(() => {
      const current = fs.fstatSync(this.#fd).mtimeMs;
      if (current !== previous) {
        previous = current;
        listener();
      }
    }, 250);
    timer.unref();
    return {
      close: () => clearInterval(timer),
      unref: () => timer.unref(),
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Relay directory descriptor is closed');
  }
}

export interface RelayWatcher {
  close(): void;
  unref(): void;
}

function ensureRootDirectory(absolute: string): void {
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const rootName = components.pop();
  if (rootName === undefined) return;

  let fd = fs.openSync(parsed.root, READ_DIRECTORY_FLAGS);
  try {
    verifyDirectoryFd(fd, parsed.root);
    for (const component of components) {
      const next = openDirectoryAt(fd, component, true, absolute);
      fs.closeSync(fd);
      fd = next!;
    }
    try {
      mkdirAt(fd, rootName);
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function openRootFd(absolute: string): number | null {
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let fd = fs.openSync(parsed.root, READ_DIRECTORY_FLAGS);
  try {
    verifyDirectoryFd(fd, parsed.root);
    for (const component of components) {
      const next = openDirectoryAt(fd, component, false, absolute);
      if (next === null) return null;
      fs.closeSync(fd);
      fd = next;
    }
    const rootFd = fd;
    fd = -1;
    return rootFd;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

/** Open every canonical configured-root component without following symlinks and return its pinned descriptor. */
export function openRelayRoot(root: string, create = false): RelayDirectoryHandle | null {
  const absolute = path.resolve(root);
  const traversalPath = canonicalTraversalPath(absolute);
  if (create) ensureRootDirectory(traversalPath);

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(traversalPath);
  } catch (error) {
    if (!create && isErrorCode(error, 'ENOENT')) return null;
    throw error;
  }

  const fd = openRootFd(canonicalRoot);
  if (fd === null) return null;
  if (create) {
    try {
      fs.fchmodSync(fd, 0o700);
    } catch {
      // best-effort on filesystems that support modes
    }
  }
  return new RelayDirectoryHandle(fd, absolute);
}
