// The slice of Go's archive/zip that unpacking a bun release needs: list a
// zip's entries and read one (stored or deflated), with its messages. Bun
// has no zip reader, and loadout adds no dependency for one.

import { inflateRawSync } from "node:zlib";

/** ZipEntry is one file of a zip, as its central directory lists it. */
export interface ZipEntry {
  name: string;
  /** isDir says the entry is a folder: a name ending in "/" or a unix folder mode. */
  isDir: boolean;
  /** read is the entry's content, checked against its CRC-32; throws as archive/zip does. */
  read(): Uint8Array;
}

const errFormat = "zip: not a valid zip file";
const errAlgorithm = "zip: unsupported compression algorithm";
const errChecksum = "zip: checksum error";

const eocdSignature = 0x06054b50;
const zip64LocatorSignature = 0x07064b50;
const zip64EocdSignature = 0x06064b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;

/** zipEntries is the archive's entries, in central-directory order; throws when it isn't a zip. */
export function zipEntries(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  const fail = (): never => {
    throw new Error(errFormat);
  };
  const inRange = (at: number, n: number) => at >= 0 && at + n <= archive.length;

  // The end-of-central-directory record: within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
    if (u32(at) === eocdSignature) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) fail();
  let count = u16(eocd + 10);
  let dirOffset = u32(eocd + 16);
  if ((count === 0xffff || dirOffset === 0xffffffff) && inRange(eocd - 20, 20) && u32(eocd - 20) === zip64LocatorSignature) {
    const record = u64(eocd - 20 + 8);
    if (!inRange(record, 56) || u32(record) !== zip64EocdSignature) fail();
    count = u64(record + 32);
    dirOffset = u64(record + 48);
  }

  const entries: ZipEntry[] = [];
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (!inRange(at, 46) || u32(at) !== centralSignature) fail();
    const method = u16(at + 10);
    const crc = u32(at + 16);
    let compressed = u32(at + 20);
    let size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const externalAttrs = u32(at + 38);
    const madeBy = u16(at + 4) >> 8;
    let localOffset = u32(at + 42);
    if (!inRange(at + 46, nameLength + extraLength + commentLength)) fail();
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    // ZIP64 extra field: the 64-bit values of whichever fields are saturated, in order.
    for (let x = at + 46 + nameLength; x + 4 <= at + 46 + nameLength + extraLength; ) {
      const id = u16(x);
      const length = u16(x + 2);
      if (id === 0x0001) {
        let f = x + 4;
        if (size === 0xffffffff) (size = u64(f)), (f += 8);
        if (compressed === 0xffffffff) (compressed = u64(f)), (f += 8);
        if (localOffset === 0xffffffff) localOffset = u64(f);
      }
      x += 4 + length;
    }
    const unixDir = madeBy === 3 && ((externalAttrs >>> 16) & 0o170000) === 0o040000;
    const isDir = name.endsWith("/") || unixDir;
    entries.push({
      name,
      isDir,
      read() {
        if (!inRange(localOffset, 30) || u32(localOffset) !== localSignature) fail();
        const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
        if (!inRange(start, compressed)) fail();
        const raw = archive.subarray(start, start + compressed);
        let data: Uint8Array;
        switch (method) {
          case 0:
            data = raw;
            break;
          case 8:
            data = new Uint8Array(inflateRawSync(raw));
            break;
          default:
            throw new Error(errAlgorithm);
        }
        if (data.length !== size || Bun.hash.crc32(data) >>> 0 !== crc) throw new Error(errChecksum);
        return data;
      },
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
