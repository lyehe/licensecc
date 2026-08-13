import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeTarPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:\//u.test(value)) {
    throw new Error(`unsafe release archive path: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe release archive path: ${value}`);
  }
  return value;
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const cut = fileName.lastIndexOf("/");
    if (cut < 1 || Buffer.byteLength(fileName.slice(0, cut)) > 155) {
      throw new Error(`tar path too long: ${name}`);
    }
    prefix = fileName.slice(0, cut);
    fileName = fileName.slice(cut + 1);
  }
  const text = (value, at, length) => header.write(value, at, length, "utf8");
  const octal = (value, at, length) => text(`${value.toString(8).padStart(length - 1, "0")}\0`, at, length);
  text(fileName, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  text("ustar\0", 257, 6);
  text("00", 263, 2);
  text(prefix, 345, 155);
  text(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

/** Write only regular canonical byte members in deterministic caller order. */
export function writeCppSourceArchive({ archivePath, members }) {
  const chunks = [];
  for (const { path, contents } of members) {
    const member = assertSafeTarPath(path);
    if (!Buffer.isBuffer(contents)) throw new Error(`release archive member is not canonical bytes: ${member}`);
    chunks.push(tarHeader(member, contents.length), contents);
    if (contents.length % 512) chunks.push(Buffer.alloc(512 - (contents.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, Buffer.concat(chunks));
  return archivePath;
}

export function tarString(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const value = field.subarray(0, nul === -1 ? length : nul);
  const suffix = nul === -1 ? Buffer.alloc(0) : field.subarray(nul + 1);
  if (suffix.some((byte) => byte !== 0 && byte !== 0x20) || value.includes(0)) {
    throw new Error(`release archive has malformed ${label}`);
  }
  const text = value.toString("utf8");
  if (text.includes("�")) throw new Error(`release archive has malformed ${label}`);
  return text;
}

export function tarOctal(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const text = field.toString("ascii").replace(/[\0 ]+$/u, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`release archive has malformed ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`release archive has malformed ${label}`);
  return value;
}

/** Validate checksum, entry type, member closure, and exact end-of-archive framing. */
export function validateArchiveMembers(archivePath, { expectedRoot, expectedMembers } = {}) {
  const archive = readFileSync(archivePath);
  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = tarOctal(header, 148, 8, "header checksum");
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    if (copy.reduce((sum, byte) => sum + byte, 0) !== stored) {
      throw new Error("release archive has an invalid header checksum");
    }
    const name = tarString(header, 0, 100, "member name");
    const prefix = tarString(header, 345, 155, "member prefix");
    const type = header[156];
    if (type !== 0 && type !== 48) throw new Error("release archive contains a non-regular entry");
    const size = tarOctal(header, 124, 12, "member size");
    const member = assertSafeTarPath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(member)) throw new Error("release archive contains duplicate members");
    const dataOffset = offset + 512;
    const padded = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(padded) || dataOffset + padded > archive.length) {
      throw new Error("release archive is truncated");
    }
    seen.add(member);
    entries.push({ member, size, dataOffset, contents: archive.subarray(dataOffset, dataOffset + size) });
    offset = dataOffset + padded;
  }
  if (offset + 1024 !== archive.length || !archive.subarray(offset, offset + 1024).every((byte) => byte === 0)) {
    throw new Error("release archive is truncated or has trailing data");
  }

  if (expectedRoot) {
    const prefix = `${expectedRoot}/`;
    if (entries.some((entry) => !entry.member.startsWith(prefix))) {
      throw new Error("release archive member is outside its expected root");
    }
    if (expectedMembers) {
      const actual = entries.map((entry) => entry.member.slice(prefix.length)).sort(ordinal);
      const expected = [...expectedMembers].sort(ordinal);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`release archive member set does not match canonical C++ inputs (expected ${expected.length}, got ${actual.length}; root=${expectedRoot})`);
      }
    }
  }
  return entries;
}
