import { open, stat } from "node:fs/promises";

const MAX_WAV_HEADER_BYTES = 64 * 1024;
const MAX_SAMPLE_RATE = 192_000;
const MIN_SAMPLE_RATE = 8_000;
const MAX_INTERVAL_BYTES = 64 * 1024;
const LEVEL_GATE_DB = -33;
const LEVEL_CUTS_DB = [-31, -29, -27, -25, -23, -20, -17];

export function levelForDb(db: number): number {
  if (!Number.isFinite(db) || db < LEVEL_GATE_DB) return 0;
  let level = 0;
  for (const cut of LEVEL_CUTS_DB) if (db >= cut) level++;
  return level;
}

/** Fixed-scale RMS analysis tuned against the validated live microphone input. */
export class LiveLevelAnalyzer {
  private samples: number[] = [];
  private smoothedRms = 0;

  update(newSamples: Int16Array, sampleRate: number): number {
    for (const sample of newSamples) this.samples.push(sample / 32768);
    const windowSamples = Math.max(1, Math.round((sampleRate * 20) / 1000));
    if (this.samples.length > windowSamples) {
      this.samples.splice(0, this.samples.length - windowSamples);
    }

    let rawRms = 0;
    if (newSamples.length && this.samples.length) {
      let sum = 0;
      for (const sample of this.samples) sum += sample * sample;
      rawRms = Math.sqrt(sum / this.samples.length);
    }
    const coefficient = rawRms > this.smoothedRms ? 0.82 : 0.45;
    this.smoothedRms += (rawRms - this.smoothedRms) * coefficient;
    const db = this.smoothedRms > 0 ? 20 * Math.log10(this.smoothedRms) : -Infinity;
    return levelForDb(db);
  }
}

type WavState = "pending" | "supported" | "unsupported";

type PcmFormat = {
  code: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
};

/** Incremental input boundary for a recorder-owned, growing WAV file. */
export class GrowingPcm16WavInput {
  readonly file: string;
  state: WavState = "pending";
  sampleRate = 16000;
  private dataOffset = 0;
  private dataSize = 0;
  private cursor = 0;

  constructor(file: string) {
    this.file = file;
  }

  get supported(): boolean {
    return this.state === "supported";
  }

  private reject(): false {
    this.state = "unsupported";
    return false;
  }

  private async parseHeader(fileSize: number): Promise<boolean> {
    if (fileSize < 12) return false;
    const handle = await open(this.file, "r");
    const readAt = async (position: number, length: number): Promise<Buffer | undefined> => {
      if (position + length > fileSize) return undefined;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return bytesRead === length ? buffer : undefined;
    };

    try {
      const riff = await readAt(0, 12);
      if (!riff) return false;
      if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE") {
        return this.reject();
      }

      let format: PcmFormat | undefined;
      for (let offset = 12; offset + 8 <= MAX_WAV_HEADER_BYTES; ) {
        const chunk = await readAt(offset, 8);
        if (!chunk) return false;
        const id = chunk.toString("ascii", 0, 4);
        const chunkSize = chunk.readUInt32LE(4);
        const body = offset + 8;
        if (id === "fmt ") {
          if (chunkSize < 16) return this.reject();
          const formatBody = await readAt(body, 16);
          if (!formatBody) return false;
          format = {
            code: formatBody.readUInt16LE(0),
            channels: formatBody.readUInt16LE(2),
            sampleRate: formatBody.readUInt32LE(4),
            blockAlign: formatBody.readUInt16LE(12),
            bitsPerSample: formatBody.readUInt16LE(14),
          };
        } else if (id === "data") {
          if (!format) return this.reject();
          if (
            format.code !== 1 ||
            format.channels !== 1 ||
            format.bitsPerSample !== 16 ||
            format.blockAlign !== 2 ||
            format.sampleRate < MIN_SAMPLE_RATE ||
            format.sampleRate > MAX_SAMPLE_RATE
          ) {
            return this.reject();
          }
          this.sampleRate = format.sampleRate;
          this.dataOffset = body;
          this.dataSize = chunkSize;
          this.cursor = body;
          this.state = "supported";
          return true;
        }

        const next = body + chunkSize + (chunkSize % 2);
        if (next <= offset || next > MAX_WAV_HEADER_BYTES) return this.reject();
        offset = next;
      }
      return this.reject();
    } finally {
      await handle.close();
    }
  }

  async readNewestInterval(intervalMs: number): Promise<Int16Array> {
    if (this.state === "unsupported") return new Int16Array();

    let fileSize: number;
    try {
      fileSize = (await stat(this.file)).size;
    } catch {
      return new Int16Array();
    }

    if (this.state === "pending" && !(await this.parseHeader(fileSize))) return new Int16Array();
    if (fileSize < this.cursor) {
      this.state = "pending";
      this.cursor = 0;
      return new Int16Array();
    }

    const declaredEnd = this.dataSize === 0 || this.dataSize === 0xffffffff
      ? fileSize
      : this.dataOffset + this.dataSize;
    const availableEnd = Math.min(fileSize, declaredEnd);
    const wanted = Math.min(
      MAX_INTERVAL_BYTES,
      Math.max(2, Math.floor((this.sampleRate * intervalMs) / 1000) * 2)
    );
    const available = Math.max(0, availableEnd - this.cursor);
    let position = this.cursor;
    if (available > wanted) {
      position = availableEnd - wanted;
      position -= (position - this.dataOffset) % 2;
    }
    const byteLength = Math.max(0, Math.min(wanted, availableEnd - position)) & ~1;
    if (!byteLength) return new Int16Array();

    const buffer = Buffer.allocUnsafe(byteLength);
    const handle = await open(this.file, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, byteLength, position));
    } finally {
      await handle.close();
    }
    const alignedBytes = bytesRead & ~1;
    this.cursor = position + alignedBytes;
    const samples = new Int16Array(alignedBytes / 2);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = buffer.readInt16LE(index * 2);
    }
    return samples;
  }
}
