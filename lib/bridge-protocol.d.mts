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

export interface StreamTimingPolicy extends RequestTimingPolicy {
  stream: TimingPolicy;
  end: TimingPolicy;
}

export interface BridgeProtocolStreamRequestBase extends Omit<BridgeProtocolRequest, "timing"> {
  timing: StreamTimingPolicy;
}

export interface BinaryStreamRequest extends BridgeProtocolStreamRequestBase {
  kind: "binary";
}

export interface AuthenticatedFrameStreamRequest extends BridgeProtocolStreamRequestBase {
  kind: "authenticated-frames";
}

export interface BinaryByteSource {
  readExactly(length: number): AsyncIterable<Uint8Array>;
}

export interface BinaryStreamContext {
  metadata: JsonValue;
  bytes: BinaryByteSource;
}

export interface AuthenticatedFrameStreamContext {
  metadata: JsonValue;
  frames: AsyncIterable<JsonValue>;
}

export type BridgeProtocolStreamResponse<T> =
  | { status: "ok"; payload: JsonValue; value: T }
  | { status: Exclude<BridgeProtocolStatus, "ok">; payload: JsonValue };

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
  options: BinaryStreamRequest,
  consumer: (context: BinaryStreamContext) => T | Promise<T>,
): Promise<BridgeProtocolStreamResponse<T>>;
export function withStream<T>(
  options: AuthenticatedFrameStreamRequest,
  consumer: (context: AuthenticatedFrameStreamContext) => T | Promise<T>,
): Promise<BridgeProtocolStreamResponse<T>>;
