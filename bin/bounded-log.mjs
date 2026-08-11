import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_SAFE_TEXT_BYTES = 96;
const SAFE_TEXT = /^[a-z0-9._:-]+$/i;

function ownedRegular(path) {
  if (!existsSync(path)) return undefined;
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 ||
      (process.getuid?.() !== undefined && value.uid !== process.getuid()) ||
      (value.mode & 0o777) !== 0o600) throw new Error("Refusing unsafe bridge log.");
  return value;
}

function safeText(value, fallback) {
  const text = typeof value === "string" && SAFE_TEXT.test(value) ? value : fallback;
  return Buffer.byteLength(text) <= MAX_SAFE_TEXT_BYTES ? text : fallback;
}

function rotate(path, incomingBytes) {
  const current = ownedRegular(path);
  if (!current || current.size + incomingBytes <= MAX_LOG_BYTES) return;
  ownedRegular(`${path}.1`);
  ownedRegular(`${path}.2`);
  if (existsSync(`${path}.2`)) unlinkSync(`${path}.2`);
  if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`);
  renameSync(path, `${path}.1`);
}

export function createBoundedLogger(path, component) {
  const safeComponent = safeText(component, "bridge");
  let previousKey = "";
  let repeats = 0;
  const append = (record) => {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (bytes.length > 1024) throw new Error("Refusing oversized bridge log record.");
    rotate(path, bytes.length);
    const descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 ||
          (process.getuid?.() !== undefined && info.uid !== process.getuid())) {
        throw new Error("Refusing unsafe bridge log.");
      }
      fchmodSync(descriptor, 0o600);
      writeSync(descriptor, bytes);
    } finally { closeSync(descriptor); }
  };
  const flushRepeats = () => {
    if (repeats > 0) append({ component: safeComponent, code: "repeated", count: repeats });
    repeats = 0;
  };
  return {
    event(code, fields = {}) {
      const record = {
        component: safeComponent,
        code: safeText(code, "unknown"),
        ...(fields.stage === undefined ? {} : { stage: safeText(fields.stage, "unknown") }),
        ...(Number.isSafeInteger(fields.retry) ? { retry: Math.max(0, Math.min(fields.retry, 1_000_000)) } : {}),
        ...(Number.isSafeInteger(fields.version) ? { version: Math.max(0, Math.min(fields.version, 1_000_000)) } : {}),
      };
      const key = JSON.stringify({
        component: record.component,
        code: record.code,
        ...(record.stage === undefined ? {} : { stage: record.stage }),
        ...(record.version === undefined ? {} : { version: record.version }),
      });
      if (key === previousKey) { repeats = Math.min(repeats + 1, 1_000_000); return; }
      flushRepeats();
      append(record);
      previousKey = key;
    },
    close() { flushRepeats(); },
  };
}

export const boundedLogPolicy = Object.freeze({ generations: 3, bytesPerGeneration: MAX_LOG_BYTES });
