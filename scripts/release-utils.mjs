import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

export const root = resolve(import.meta.dirname, "..");

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function filesUnder(directory) {
  const base = resolve(directory);
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are forbidden in release input: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) found.push({ absolute, path: relative(base, absolute).replaceAll("\\", "/") });
      else throw new Error(`Unsupported release input: ${absolute}`);
    }
  }
  await visit(base);
  return found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function describeFiles(directory) {
  const entries = [];
  for (const file of await filesUnder(directory)) {
    const data = await readFile(file.absolute);
    entries.push({ path: file.path, bytes: data.length, sha256: sha256(data) });
  }
  return entries;
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let result = 0xffffffff;
  for (const byte of buffer) result = crcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}

function endOfCentralDirectory(count, centralSize, centralOffset) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(centralSize, 12);
  buffer.writeUInt32LE(centralOffset, 16);
  return buffer;
}

/** Write a byte-for-byte deterministic ZIP with fixed 1980-01-01 metadata. */
export async function writeDeterministicZip(output, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const name = Buffer.from(entry.path.replaceAll("\\", "/"), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0x0021, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((0o100644 * 65_536) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const archive = Buffer.concat([...chunks, ...central, endOfCentralDirectory(entries.length, centralSize, offset)]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, archive);
  return { bytes: archive.length, sha256: sha256(archive) };
}

export async function zipEntriesFromDirectory(directory, prefix = "") {
  const result = [];
  for (const file of await filesUnder(directory)) {
    result.push({ path: `${prefix}${file.path}`, data: await readFile(file.absolute) });
  }
  return result;
}

export async function isRegularFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
