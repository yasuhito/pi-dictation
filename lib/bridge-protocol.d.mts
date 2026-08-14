export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type BridgeEndpoint =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number };

export interface BridgeCredential {
  id: string;
  secret: Uint8Array;
}

export type BridgeProtocolStatus =
  | "ok"
  | "busy"
  | "not-found"
  | "request-conflict"
  | "invalid-state"
  | "failed"
  | "version-mismatch";

export type TimingPolicy =
  | { kind: "absolute"; at: number }
  | { kind: "no-progress"; timeoutMs: number };

export interface RequestTimingPolicy {
  connect: TimingPolicy;
  challenge: TimingPolicy;
  requestWrite: TimingPolicy;
  response: TimingPolicy;
}

export interface StreamTimingPolicy extends RequestTimingPolicy {
  stream: TimingPolicy;
  end: TimingPolicy;
}

export interface BridgeProtocolRequest {
  endpoint: BridgeEndpoint;
  credential: BridgeCredential;
  requestId: string;
  operation: string;
  payload: JsonObject;
  timing: RequestTimingPolicy;
  signal: AbortSignal;
}

export interface BridgeProtocolResponse {
  status: BridgeProtocolStatus;
  payload: JsonValue;
}

export interface BridgeProtocolStreamRequest extends Omit<BridgeProtocolRequest, "timing"> {
  kind: "binary" | "authenticated-frames";
  timing: StreamTimingPolicy;
}

export interface BoundedByteSource {
  readExactly(length: number): AsyncIterable<Uint8Array>;
}

export interface BinaryStream {
  metadata: JsonValue;
  bytes: BoundedByteSource;
}

export interface AuthenticatedFrameStream {
  metadata: JsonValue;
  frames: AsyncIterable<JsonValue>;
}

export type BridgeProtocolStreamResponse<T> =
  | { status: Exclude<BridgeProtocolStatus, "ok">; payload: JsonValue }
  | { status: "ok"; payload: JsonValue; value: T };

export type BridgeProtocolFailureKind = "transport" | "deadline" | "cancelled" | "malformed" | "authentication";
export type BridgeProtocolFailureStage = "connect" | "challenge" | "request-write" | "response" | "stream";

export class BridgeProtocolFailure extends Error {
  readonly kind: BridgeProtocolFailureKind;
  readonly stage: BridgeProtocolFailureStage;
  readonly cause?: unknown;
  constructor(kind: BridgeProtocolFailureKind, stage: BridgeProtocolFailureStage, cause?: unknown);
}

export function request(options: BridgeProtocolRequest): Promise<BridgeProtocolResponse>;
export function withStream<T>(
  options: BridgeProtocolStreamRequest & { kind: "binary" },
  consumer: (stream: BinaryStream) => T | Promise<T>,
): Promise<BridgeProtocolStreamResponse<T>>;
export function withStream<T>(
  options: BridgeProtocolStreamRequest & { kind: "authenticated-frames" },
  consumer: (stream: AuthenticatedFrameStream) => T | Promise<T>,
): Promise<BridgeProtocolStreamResponse<T>>;
