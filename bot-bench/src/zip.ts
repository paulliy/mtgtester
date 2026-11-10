/**
 * A minimal ZIP writer (deflate, UTF-8 names, fixed timestamps), so a bundle is one file a person
 * can attach and the same inputs always produce the same bytes. No dependency, no streaming: a
 * bundle is a few hundred kilobytes of text.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string;
  data: Uint8Array;
}

/** 1980-01-01 00:00:00, the earliest DOS timestamp: bundles are byte-for-byte reproducible. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
/** Bit 11: the file name is UTF-8. */
const FLAGS = 0x0800;

export function zipArchive(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..'))
      throw new Error(`unsafe archive path: ${entry.path}`);
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads an archive back through its central directory, as an unzip tool does, checking each CRC. */
export function readZipArchive(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const total = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < total; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central header');
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    const data = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize));
    if (crc32(data) !== archive.readUInt32LE(cursor + 16)) throw new Error(`bad crc for ${name}`);
    files.set(name, data);
    cursor += 46 + nameLength;
  }
  return files;
}
