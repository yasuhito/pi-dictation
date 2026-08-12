import Foundation
import AVFoundation
import CryptoKit
import Security
import Darwin
import CoreMedia
import AudioToolbox
import AppKit

private let productIdentifier = "com.yasuhito.pi-dictation.bridge"
private let protocolVersion = 3
private let maximumFrameBytes = 64 * 1024
private let maximumWavHeaderBytes = 64 * 1024
private let streamingBufferBytes = 64 * 1024
#if PROTOCOL_TESTING
private let fixedSocketSendBufferBytes = Int32(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_SEND_BUFFER_BYTES"] ?? "") ?? 64 * 1024
private let maximumRetainedWavFiles = Int(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_RETAINED_FILES"] ?? "") ?? 2
private let maximumRetainedWavBytes = Int64(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_RETAINED_BYTES"] ?? "") ?? 256 * 1024 * 1024
private let authenticationDeadlineSeconds = max(0.05, (Double(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_AUTH_DEADLINE_MS"] ?? "") ?? 5_000) / 1000)
#else
private let fixedSocketSendBufferBytes: Int32 = 64 * 1024
private let maximumRetainedWavFiles = 2
private let maximumRetainedWavBytes: Int64 = 256 * 1024 * 1024
private let authenticationDeadlineSeconds: TimeInterval = 5
#endif
private let challengeBytes = 32
private let unknownCredentialSecret = Data(repeating: 0, count: 32).base64EncodedString()
private let resultRetentionSeconds: TimeInterval = 10 * 60
private let requestReceiptRetentionSeconds = resultRetentionSeconds
#if PROTOCOL_TESTING
private let ownerLivenessSeconds: TimeInterval = max(0.1, (Double(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_LIVENESS_MS"] ?? "") ?? 15_000) / 1000)
private let initialOwnerLivenessSeconds: TimeInterval = max(0.05, (Double(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_INITIAL_LIVENESS_MS"] ?? "") ?? ownerLivenessSeconds * 1000) / 1000)
#else
private let ownerLivenessSeconds: TimeInterval = 15
private let initialOwnerLivenessSeconds: TimeInterval = ownerLivenessSeconds
#endif
private let levelIntervalMilliseconds = 50
private let levelReplaySlots = 600
private let levelSubscriberQueueLimit = 64
private let maximumDiagnosticLevelObservations = 64
private let maximumConnections = 16
private let maximumConnectionsPerCredential = 4
private let validRequestOperations: Set<String> = [
    "health", "start", "levels", "subscribe-levels", "status", "stop", "fetch", "cancel", "acknowledge",
    "credential-effects", "credential-cancel-recordings", "credential-quiesce-if-idle", "credential-revoke", "credential-revoke-if-idle", "credential-revoke-if-no-active",
]
private let observationRequestOperations: Set<String> = ["health", "levels", "subscribe-levels", "status"]
private let maximumObservationRequestReceiptsPerCredential = 16_384
private let maximumControlRequestReceiptsPerCredential = 64
#if PROTOCOL_TESTING
private let maximumRequestRegistryBytes = Int(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_REGISTRY_BYTES"] ?? "") ?? 32 * 1024 * 1024
#else
private let maximumRequestRegistryBytes = 32 * 1024 * 1024
#endif

private struct Credential: Decodable {
    let id: String
    let secret: String
}

private struct OwnershipReceipt: Decodable {
    let product: String
    let installId: String
}

private struct PreflightReceipt: Decodable {
    let product: String
    let installId: String
    let executableSha256: String
}

private struct PreflightResult: Encodable {
    let permission: String
    let capture: String
}

private enum CompanionFailure: Error {
    case unsafeStorage
    case invalidCredential
    case invalidSocket
    case invalidFrame
    case authentication
    case busy
    case storageFull
    case notFound
    case requestConflict
    case invalidState
    case failed
}

private func permissionName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

private final class CaptureProbe: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let callbackQueue = DispatchQueue(label: "com.yasuhito.pi-dictation.bridge.preflight")
    private let lock = NSLock()
    private var observers: [NSObjectProtocol] = []
    private var receivedSamples = false
    private var observedSignal = false
    private var deviceLost = false
    private var captureFailed = false
    private var pinnedDevice: AVCaptureDevice?

    func run(seconds: TimeInterval) -> String {
        guard let device = AVCaptureDevice.default(for: .audio) else { return "no-device" }
        pinnedDevice = device
        do {
            let input = try AVCaptureDeviceInput(device: device)
            let output = AVCaptureAudioDataOutput()
            output.setSampleBufferDelegate(self, queue: callbackQueue)
            session.beginConfiguration()
            guard session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                return "capture-failed"
            }
            session.addInput(input)
            session.addOutput(output)
            session.commitConfiguration()

            observers.append(NotificationCenter.default.addObserver(
                forName: AVCaptureDevice.wasDisconnectedNotification,
                object: device,
                queue: nil
            ) { [weak self] _ in self?.setDeviceLost() })
            observers.append(NotificationCenter.default.addObserver(
                forName: AVCaptureSession.runtimeErrorNotification,
                object: session,
                queue: nil
            ) { [weak self] _ in self?.setCaptureFailed() })

            session.startRunning()
            if !session.isRunning {
                setCaptureFailed()
            } else {
                Thread.sleep(forTimeInterval: seconds)
            }
        } catch {
            captureFailed = true
        }

        if session.isRunning { session.stopRunning() }
        callbackQueue.sync {}
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        pinnedDevice = nil

        lock.lock()
        defer { lock.unlock() }
        if deviceLost { return "device-lost" }
        if captureFailed { return "capture-failed" }
        if !receivedSamples { return "no-samples" }
        return observedSignal ? "observed" : "digital-silence"
    }

    private func setDeviceLost() {
        lock.lock()
        deviceLost = true
        lock.unlock()
        session.stopRunning()
    }

    private func setCaptureFailed() {
        lock.lock()
        captureFailed = true
        lock.unlock()
        session.stopRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        var requiredSize = 0
        var retainedBlock: CMBlockBuffer?
        let sizeStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &requiredSize,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &retainedBlock
        )
        guard sizeStatus == noErr, requiredSize >= MemoryLayout<AudioBufferList>.size else { return }
        let rawList = UnsafeMutableRawPointer.allocate(
            byteCount: requiredSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { rawList.deallocate() }
        let list = rawList.assumingMemoryBound(to: AudioBufferList.self)
        let listStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: list,
            bufferListSize: requiredSize,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            blockBufferOut: &retainedBlock
        )
        guard listStatus == noErr else { return }
        var nonzero = false
        var hasBytes = false
        for buffer in UnsafeMutableAudioBufferListPointer(list) {
            guard let data = buffer.mData, buffer.mDataByteSize > 0 else { continue }
            hasBytes = true
            let bytes = UnsafeRawBufferPointer(start: data, count: Int(buffer.mDataByteSize))
            if bytes.contains(where: { $0 != 0 }) { nonzero = true }
        }
        guard hasBytes else { return }
        lock.lock()
        receivedSamples = true
        observedSignal = observedSignal || nonzero
        lock.unlock()
    }
}

private func requestPermissionIfNeeded() -> AVAuthorizationStatus {
    var status = AVCaptureDevice.authorizationStatus(for: .audio)
    if status == .notDetermined {
        let semaphore = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in semaphore.signal() }
        _ = semaphore.wait(timeout: .now() + 60)
        status = AVCaptureDevice.authorizationStatus(for: .audio)
    }
    return status
}

private func fixedPaths() -> (root: String, runtime: String, socket: String, credential: String, hostCredentials: String) {
#if PROTOCOL_TESTING
    if let testing = ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_ROOT"] {
        let root = testing + "/root"
        let runtime = testing + "/runtime"
        return (root, runtime, runtime + "/companion.sock", root + "/credential.json", root + "/hosts")
    }
#endif
    let home = NSHomeDirectory()
    let root = home + "/Library/Application Support/pi-dictation/bridge"
    let runtime = home + "/Library/Caches/pi-dictation/bridge"
    return (root, runtime, runtime + "/companion.sock", root + "/credential.json", root + "/hosts")
}

#if PROTOCOL_TESTING
private final class ProtocolResourceMetrics {
    static let shared = ProtocolResourceMetrics()
    private let lock = NSLock()
    private var maxima: [String: Int] = [:]

    func record(_ name: String, bytes: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard bytes > (maxima[name] ?? 0) else { return }
        maxima[name] = bytes
        guard let data = try? JSONSerialization.data(withJSONObject: maxima, options: [.sortedKeys]) else { return }
        let path = fixedPaths().runtime + "/resource-metrics.json"
        let descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return }
        defer { Darwin.close(descriptor) }
        try? writeAll(descriptor, data: data)
    }
}

private func recordResourceMetric(_ name: String, bytes: Int) {
    ProtocolResourceMetrics.shared.record(name, bytes: bytes)
}
#else
private func recordResourceMetric(_ name: String, bytes: Int) {}
#endif

private func writeExclusive(_ data: Data, to path: String) throws {
    let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw CompanionFailure.unsafeStorage }
    var complete = false
    defer {
        Darwin.close(descriptor)
        if !complete { unlink(path) }
    }
    try writeAll(descriptor, data: data)
    guard fsync(descriptor) == 0 else { throw CompanionFailure.unsafeStorage }
    complete = true
}

private func writePreflightResult(to path: String) throws {
    let locations = fixedPaths()
    try verifyDirectory(locations.runtime)
    let url = URL(fileURLWithPath: path).standardizedFileURL
    let parent = url.deletingLastPathComponent().path
    let name = url.lastPathComponent
    let identifier = String(name.dropFirst("preflight-".count).dropLast(".json".count))
    guard parent == locations.runtime,
          name.hasPrefix("preflight-"), name.hasSuffix(".json"),
          UUID(uuidString: identifier) != nil else { throw CompanionFailure.unsafeStorage }
    var existing = stat()
    guard lstat(url.path, &existing) != 0, errno == ENOENT else { throw CompanionFailure.unsafeStorage }
    let status = requestPermissionIfNeeded()
    let capture = status == .authorized ? CaptureProbe().run(seconds: 5) : "capture-failed"
    let data = try JSONEncoder().encode(PreflightResult(permission: permissionName(status), capture: capture))
    try writeExclusive(data, to: url.path)
}

private func verifyDirectory(_ path: String) throws {
    var info = stat()
    guard lstat(path, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == getuid(),
          (info.st_mode & 0o777) == 0o700 else { throw CompanionFailure.unsafeStorage }
}

private func readPrivateData(_ path: String, maximumBytes: Int = 4096) throws -> Data {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CompanionFailure.unsafeStorage }
    defer { Darwin.close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(),
          (info.st_mode & 0o777) == 0o600,
          info.st_nlink == 1,
          info.st_size > 0,
          info.st_size <= off_t(maximumBytes) else { throw CompanionFailure.unsafeStorage }
    return try readExactly(descriptor, count: Int(info.st_size))
}

private func readCredential(_ path: String) throws -> Credential {
    let credential = try JSONDecoder().decode(Credential.self, from: readPrivateData(path))
    guard canonicalUUID(credential.id),
          canonicalBase64(credential.secret, bytes: 32) != nil else { throw CompanionFailure.invalidCredential }
    return credential
}

private func readCredentials(primary: String, hosts: String) throws -> [String: Credential] {
    let primaryCredential = try readCredential(primary)
    var credentials = [primaryCredential.id: primaryCredential]
    var hostDirectory = stat()
    if lstat(hosts, &hostDirectory) != 0 {
        guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
        return credentials
    }
    try verifyDirectory(hosts)
    let names = try FileManager.default.contentsOfDirectory(atPath: hosts)
    for name in names {
        guard name.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil else {
            throw CompanionFailure.unsafeStorage
        }
        let directory = hosts + "/" + name
        try verifyDirectory(directory)
        for credentialName in ["credential.json", "credential.next.json"] {
            let credentialPath = directory + "/" + credentialName
            var credentialInfo = stat()
            if lstat(credentialPath, &credentialInfo) != 0 {
                guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
                continue
            }
            let credential: Credential
            do { credential = try readCredential(credentialPath) }
            catch { continue }
            guard credentials[credential.id] == nil else { throw CompanionFailure.invalidCredential }
            credentials[credential.id] = credential
        }
    }
    return credentials
}

private func executableDigest() throws -> String {
    let descriptor = open(CommandLine.arguments[0], O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CompanionFailure.unsafeStorage }
    defer { Darwin.close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(),
          (info.st_mode & 0o777) == 0o700,
          info.st_nlink == 1 else { throw CompanionFailure.unsafeStorage }
    var digest = SHA256()
    var buffer = [UInt8](repeating: 0, count: streamingBufferBytes)
    while true {
        let count = buffer.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress!, bytes.count)
        }
        if count == 0 { break }
        if count < 0, errno == EINTR { continue }
        guard count > 0 else { throw CompanionFailure.unsafeStorage }
        digest.update(data: Data(buffer[0..<count]))
    }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
}

private func verifyPreflightReceipt(root: String) throws {
    let decoder = JSONDecoder()
    let ownership = try decoder.decode(OwnershipReceipt.self, from: readPrivateData(root + "/ownership.json"))
    let preflight = try decoder.decode(PreflightReceipt.self, from: readPrivateData(root + "/preflight.json"))
    guard ownership.product == productIdentifier,
          preflight.product == productIdentifier,
          ownership.installId == preflight.installId,
          preflight.executableSha256 == (try executableDigest()) else { throw CompanionFailure.unsafeStorage }
}

private func randomChallenge() throws -> Data {
    var data = Data(count: challengeBytes)
    let result = data.withUnsafeMutableBytes { bytes in
        SecRandomCopyBytes(kSecRandomDefault, challengeBytes, bytes.baseAddress!)
    }
    guard result == errSecSuccess else { throw CompanionFailure.authentication }
    return data
}

private func authEncoding(_ fields: [Data]) -> Data {
    var result = Data("pi-dictation-bridge-auth-v1\0".utf8)
    for field in fields {
        var length = UInt32(field.count).bigEndian
        withUnsafeBytes(of: &length) { result.append(contentsOf: $0) }
        result.append(field)
    }
    return result
}

private func utf8(_ value: String) -> Data { Data(value.utf8) }

private func authenticationTag(secret: Data, fields: [Data]) -> Data {
    let key = SymmetricKey(data: secret)
    return Data(HMAC<SHA256>.authenticationCode(for: authEncoding(fields), using: key))
}

private func constantTimeEqual(_ left: Data, _ right: Data) -> Bool {
    guard left.count == right.count else { return false }
    var difference: UInt8 = 0
    for index in left.indices { difference |= left[index] ^ right[index] }
    return difference == 0
}

private func jsonData(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

private func readExactly(_ descriptor: Int32, count: Int) throws -> Data {
    var data = Data(count: count)
    var offset = 0
    while offset < count {
        let amount = data.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress!.advanced(by: offset), count - offset)
        }
        guard amount > 0 else { throw CompanionFailure.invalidFrame }
        offset += amount
    }
    return data
}

private struct StrictJSON {
    let data: Data
    var index = 0

    mutating func validate() throws {
        skipWhitespace()
        try parseValue()
        skipWhitespace()
        guard index == data.count else { throw CompanionFailure.invalidFrame }
    }

    private mutating func parseValue() throws {
        guard index < data.count else { throw CompanionFailure.invalidFrame }
        switch data[index] {
        case 0x7b: try parseObject()
        case 0x5b: try parseArray()
        case 0x22: _ = try parseString()
        default: try parsePrimitive()
        }
    }

    private mutating func parseObject() throws {
        index += 1
        skipWhitespace()
        if consume(0x7d) { return }
        var keys = Set<String>()
        while true {
            guard index < data.count, data[index] == 0x22 else { throw CompanionFailure.invalidFrame }
            let key = try parseString()
            guard keys.insert(key).inserted else { throw CompanionFailure.invalidFrame }
            skipWhitespace()
            guard consume(0x3a) else { throw CompanionFailure.invalidFrame }
            skipWhitespace()
            try parseValue()
            skipWhitespace()
            if consume(0x7d) { return }
            guard consume(0x2c) else { throw CompanionFailure.invalidFrame }
            skipWhitespace()
        }
    }

    private mutating func parseArray() throws {
        index += 1
        skipWhitespace()
        if consume(0x5d) { return }
        while true {
            try parseValue()
            skipWhitespace()
            if consume(0x5d) { return }
            guard consume(0x2c) else { throw CompanionFailure.invalidFrame }
            skipWhitespace()
        }
    }

    private mutating func parseString() throws -> String {
        let start = index
        index += 1
        while index < data.count {
            let byte = data[index]
            index += 1
            if byte == 0x22 {
                let encoded = data.subdata(in: start..<index)
                guard let value = try? JSONDecoder().decode(String.self, from: encoded) else {
                    throw CompanionFailure.invalidFrame
                }
                return value
            }
            if byte == 0x5c {
                guard index < data.count else { throw CompanionFailure.invalidFrame }
                index += 1
            }
        }
        throw CompanionFailure.invalidFrame
    }

    private mutating func parsePrimitive() throws {
        let start = index
        while index < data.count, ![0x20, 0x09, 0x0a, 0x0d, 0x2c, 0x5d, 0x7d].contains(data[index]) {
            index += 1
        }
        guard index > start else { throw CompanionFailure.invalidFrame }
    }

    private mutating func skipWhitespace() {
        while index < data.count, [0x20, 0x09, 0x0a, 0x0d].contains(data[index]) { index += 1 }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        guard index < data.count, data[index] == byte else { return false }
        index += 1
        return true
    }
}

private func strictJSONObject(_ data: Data) throws -> [String: Any] {
    var validator = StrictJSON(data: data)
    try validator.validate()
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw CompanionFailure.invalidFrame
    }
    return value
}

private func readFrame(_ descriptor: Int32) throws -> [String: Any] {
    let header = try readExactly(descriptor, count: 4)
    let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    guard length >= 2, length <= maximumFrameBytes else { throw CompanionFailure.invalidFrame }
    return try strictJSONObject(readExactly(descriptor, count: Int(length)))
}

private func requireStreamEnd(_ descriptor: Int32) throws {
    var byte: UInt8 = 0
    while true {
        let amount = Darwin.read(descriptor, &byte, 1)
        if amount == 0 { return }
        if amount < 0, errno == EINTR { continue }
        throw CompanionFailure.invalidFrame
    }
}

private func writeAll(_ descriptor: Int32, data: Data) throws {
    var offset = 0
    while offset < data.count {
        let amount = data.withUnsafeBytes { bytes in
            Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), data.count - offset)
        }
        guard amount > 0 else { throw CompanionFailure.invalidFrame }
        offset += amount
    }
}

private func writeFrame(_ descriptor: Int32, object: [String: Any]) throws {
    let payload = try jsonData(object)
    guard payload.count <= maximumFrameBytes else { throw CompanionFailure.invalidFrame }
    var length = UInt32(payload.count).bigEndian
    var framed = Data(bytes: &length, count: 4)
    framed.append(payload)
    try writeAll(descriptor, data: framed)
}

private func exactKeys(_ object: [String: Any], _ keys: Set<String>) -> Bool {
    Set(object.keys) == keys
}

private func canonicalUUID(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                options: .regularExpression) != nil
}

private func canonicalBase64(_ value: String, bytes: Int? = nil) -> Data? {
    guard !value.isEmpty, value.utf8.count % 4 == 0,
          let decoded = Data(base64Encoded: value), decoded.base64EncodedString() == value,
          bytes == nil || decoded.count == bytes else { return nil }
    return decoded
}

private func jsonInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let integer = number.intValue
    guard NSNumber(value: integer) == number else { return nil }
    return integer
}

private struct AuthenticatedRequest {
    let credential: Credential
    let clientVersion: Int
    let secret: Data
    let challenge: Data
    let requestId: String
    let operation: String
    let payloadData: Data
    let payload: [String: Any]
}

private struct PersistedRecording: Codable {
    let schemaVersion: Int
    let id: String
    let ownerId: String
    let leaseHash: String
    let maximumResultBytes: Int64?
    var state: String
    var length: Int?
    var sha256: String?
    var completion: String?
    var failureReason: String?
    var terminalAt: TimeInterval?
}

private struct PersistedRequestReceipt: Codable {
    let ownerId: String
    let requestId: String
    let clientVersion: Int
    let operation: String
    let contentHash: String
    let receivedAt: TimeInterval
    var responseStatus: String?
    var responsePayload: Data?
}

private struct PersistedRequestRegistry: Codable {
    let schemaVersion: Int
    let receipts: [PersistedRequestReceipt]
}

private struct PersistedCredentialRevocation: Codable {
    let schemaVersion: Int
    let ownerId: String
    let requestId: String
    let clientVersion: Int
    let operation: String
    let contentHash: String
    let effects: [String: Int]
    let revokedAt: TimeInterval
}

private final class PcmLevelReader {
    private let url: URL
    private var cursor: UInt64?
    private var pending = Data()
    private var intervalsToDiscard = 0

    init(url: URL) { self.url = url }

    func readIntervals(startingAt sequence: Int) throws -> [[String: Any]] {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        if cursor == nil {
            let header = try handle.read(upToCount: maximumFrameBytes) ?? Data()
            recordResourceMetric("capture", bytes: header.count)
            if header.count < 44 { return [] }
            guard String(data: header[0..<4], encoding: .ascii) == "RIFF",
                  String(data: header[8..<12], encoding: .ascii) == "WAVE" else {
                throw CompanionFailure.failed
            }
            var offset = 12
            while offset + 8 <= header.count {
                let size = Int(UInt32(header[offset + 4]) | UInt32(header[offset + 5]) << 8 |
                               UInt32(header[offset + 6]) << 16 | UInt32(header[offset + 7]) << 24)
                if String(data: header[offset..<(offset + 4)], encoding: .ascii) == "data" {
                    cursor = UInt64(offset + 8)
                    break
                }
                let next = offset + 8 + size + (size % 2)
                guard next > offset else { return [] }
                offset = next
            }
            guard cursor != nil else { throw CompanionFailure.failed }
        }
        let bytesPerInterval = 16000 * levelIntervalMilliseconds / 1000 * 2
        var events: [[String: Any]] = []
        func drainPendingIntervals() {
            while intervalsToDiscard > 0, pending.count >= bytesPerInterval {
                pending.removeFirst(bytesPerInterval)
                intervalsToDiscard -= 1
            }
            while pending.count >= bytesPerInterval {
                let interval = pending.prefix(bytesPerInterval)
                var sum = 0.0
                var offset = interval.startIndex
                while offset + 1 < interval.endIndex {
                    let bits = UInt16(interval[offset]) | UInt16(interval[offset + 1]) << 8
                    let sample = Double(Int16(bitPattern: bits)) / 32768.0
                    sum += sample * sample
                    offset += 2
                }
                let eventSequence = sequence + events.count
                let dbfs: Any = sum == 0 ? "silence" : 20.0 * log10(sqrt(sum / Double(bytesPerInterval / 2)))
                events.append([
                    "type": "observation", "sequence": eventSequence,
                    "capturedAtMs": eventSequence * levelIntervalMilliseconds, "dbfs": dbfs,
                ])
                pending.removeFirst(bytesPerInterval)
            }
        }
        try handle.seek(toOffset: cursor!)
        var chunksRead = 0
        while chunksRead < levelReplaySlots,
              let chunk = try handle.read(upToCount: bytesPerInterval), !chunk.isEmpty {
            chunksRead += 1
            pending.append(chunk)
            recordResourceMetric("capture", bytes: pending.count)
            cursor! += UInt64(chunk.count)
            drainPendingIntervals()
        }
        return events
    }

    func markUnavailableInterval() { intervalsToDiscard += 1 }
}

private final class LevelSubscriber {
    let descriptor: Int32
    private let request: AuthenticatedRequest
    private let queue = DispatchQueue(label: "com.yasuhito.pi-dictation.bridge.level-subscriber")
    private let lock = NSLock()
    private let finished = DispatchSemaphore(value: 0)
    private var replay: [[String: Any]] = []
    private var pending: [[String: Any]] = []
    private var running = false
    private var draining = false
    private var closed = false
    private var streamSequence = 0

    init(descriptor: Int32, request: AuthenticatedRequest) {
        self.descriptor = descriptor
        self.request = request
    }

    func enqueueReplay(_ event: [String: Any]) {
        lock.lock()
        guard !closed, !running, replay.count < levelReplaySlots else {
            lock.unlock()
            close()
            return
        }
        replay.append(event)
        lock.unlock()
    }

    func enqueue(_ event: [String: Any]) {
        lock.lock()
        guard !closed, pending.count < levelSubscriberQueueLimit else {
            lock.unlock()
            close()
            return
        }
        pending.append(event)
        recordResourceMetric("levelQueue", bytes: pending.count)
        scheduleDrainLocked()
        lock.unlock()
    }

    func start() {
        lock.lock()
        running = true
        scheduleDrainLocked()
        lock.unlock()
    }

    func wait() { finished.wait() }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        recordResourceMetric("levelDisconnect", bytes: 1)
        replay.removeAll()
        pending.removeAll()
        lock.unlock()
        shutdown(descriptor, SHUT_RDWR)
        finished.signal()
    }

    private func scheduleDrainLocked() {
        guard running, !draining, !closed, (!replay.isEmpty || !pending.isEmpty) else { return }
        draining = true
        queue.async { [weak self] in self?.drain() }
    }

    private func drain() {
        while true {
            lock.lock()
            guard !closed, !replay.isEmpty || !pending.isEmpty else {
                draining = false
                lock.unlock()
                return
            }
            let event = replay.isEmpty ? pending.removeFirst() : replay.removeFirst()
            let currentSequence = streamSequence
            streamSequence += 1
            lock.unlock()
            do {
#if PROTOCOL_TESTING
                if let delayText = ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_LEVEL_WRITE_DELAY_MS"],
                   let delay = UInt32(delayText), delay > 0 { usleep(delay * 1_000) }
#endif
                let payload = try jsonData(event)
                let eventTag = authenticationTag(secret: request.secret, fields: [
                    utf8("stream"), utf8(String(request.clientVersion)), utf8(String(protocolVersion)),
                    request.challenge, utf8(request.credential.id), utf8(request.requestId),
                    utf8(String(currentSequence)), payload,
                ])
                try writeFrame(descriptor, object: [
                    "type": "level-event", "version": protocolVersion, "requestId": request.requestId,
                    "streamSequence": currentSequence, "payload": payload.base64EncodedString(), "hmac": eventTag.hex,
                ])
                if event["type"] as? String == "terminal" { close(); return }
            } catch { close(); return }
        }
    }
}

private final class BridgeRecording {
    let id: String
    let ownerId: String
    let leaseHash: Data
    let url: URL
    var recorder: AVAudioRecorder?
    var state: String
    var length: Int?
    var sha256: String?
    var completion: String
    var failureReason: String?
    var terminalAt: TimeInterval?
    var lastOwnerProofUptimeNanoseconds: UInt64
    var observations: [[String: Any]] = []
    var sequence = 0
    let levelReader: PcmLevelReader
    let levelReaderLock = NSLock()
    var levelSubscriber: LevelSubscriber?
    var levelTimer: DispatchSourceTimer?
    var durationTimer: DispatchWorkItem?
    var durationWatchdog: Process?
    var durationWatchdogRequests: Pipe?
    var durationWatchdogRequestData = Data()
    var captureStartedAtUptimeNanoseconds: UInt64?
    var ownerLivenessTimer: DispatchSourceTimer?
    var retentionTimer: DispatchWorkItem?
    var deviceObserver: NSObjectProtocol?
    let maximumResultBytes: Int64
    var activeFetchDescriptor: Int32?

    init(id: String, ownerId: String, leaseHash: Data, url: URL, maximumResultBytes: Int64,
         state: String = "recording", length: Int? = nil, sha256: String? = nil,
         completion: String = "stopped", failureReason: String? = nil,
         terminalAt: TimeInterval? = nil, recorder: AVAudioRecorder? = nil) {
        self.id = id
        self.ownerId = ownerId
        self.leaseHash = leaseHash
        self.url = url
        self.maximumResultBytes = maximumResultBytes
        self.state = state
        self.length = length
        self.sha256 = sha256
        self.completion = completion
        self.failureReason = failureReason
        self.terminalAt = terminalAt
        self.lastOwnerProofUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
        self.recorder = recorder
        self.levelReader = PcmLevelReader(url: url)
    }
}

#if PROTOCOL_TESTING
private func writeProtocolTestingWav(to url: URL) throws {
    let requested = Int(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_WAV_DATA_BYTES"] ?? "") ?? 3200
    let requestedJunk = Int(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_WAV_JUNK_BYTES"] ?? "") ?? 0
    let evenBytes = requested - requested % 2
    let evenJunkBytes = requestedJunk - requestedJunk % 2
    let totalPayloadBytes = Int64(36) + Int64(evenBytes) + (evenJunkBytes > 0 ? Int64(8 + evenJunkBytes) : 0)
    guard evenBytes >= 2, evenJunkBytes >= 0, totalPayloadBytes <= Int64(UInt32.max) else { throw CompanionFailure.failed }
    let dataBytes = UInt32(evenBytes)
    var header: [UInt8] = []
    func appendASCII(_ value: String) { header.append(contentsOf: value.utf8) }
    func appendLE16(_ value: UInt16) {
        header.append(UInt8(value & 0xff)); header.append(UInt8((value >> 8) & 0xff))
    }
    func appendLE32(_ value: UInt32) {
        header.append(UInt8(value & 0xff)); header.append(UInt8((value >> 8) & 0xff))
        header.append(UInt8((value >> 16) & 0xff)); header.append(UInt8((value >> 24) & 0xff))
    }
    appendASCII("RIFF"); appendLE32(UInt32(totalPayloadBytes)); appendASCII("WAVE")
    appendASCII("fmt "); appendLE32(16); appendLE16(1); appendLE16(1)
    appendLE32(16000); appendLE32(32000); appendLE16(2); appendLE16(16)
    appendASCII("data"); appendLE32(dataBytes)

    let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw CompanionFailure.failed }
    var complete = false
    defer {
        Darwin.close(descriptor)
        if !complete { unlink(url.path) }
    }
    let headerData = Data(header)
    recordResourceMetric("capture", bytes: headerData.count)
    try writeAll(descriptor, data: headerData)
    let chunkSamples = streamingBufferBytes / 2
    var chunk = Data(capacity: streamingBufferBytes)
    for _ in 0..<chunkSamples { chunk.append(contentsOf: [0xb0, 0x04]) }
    var remaining = Int(dataBytes)
    while remaining > 0 {
        let count = min(remaining, chunk.count)
        recordResourceMetric("capture", bytes: count)
        try writeAll(descriptor, data: count == chunk.count ? chunk : Data(chunk.prefix(count)))
        remaining -= count
    }
    if evenJunkBytes > 0 {
        var junkHeader: [UInt8] = []
        junkHeader.append(contentsOf: "JUNK".utf8)
        let junkSize = UInt32(evenJunkBytes)
        junkHeader.append(UInt8(junkSize & 0xff)); junkHeader.append(UInt8((junkSize >> 8) & 0xff))
        junkHeader.append(UInt8((junkSize >> 16) & 0xff)); junkHeader.append(UInt8((junkSize >> 24) & 0xff))
        try writeAll(descriptor, data: Data(junkHeader))
        let zeros = Data(count: streamingBufferBytes)
        var junkRemaining = evenJunkBytes
        while junkRemaining > 0 {
            let count = min(junkRemaining, zeros.count)
            recordResourceMetric("capture", bytes: count)
            try writeAll(descriptor, data: count == zeros.count ? zeros : Data(zeros.prefix(count)))
            junkRemaining -= count
        }
    }
    guard fsync(descriptor) == 0 else { throw CompanionFailure.failed }
    complete = true
}
#endif

func withPinnedDefaultInput<Device: AnyObject>(
    select: () -> Device?,
    identity: (Device) -> String,
    observe: (Device) -> Void,
    capture: (Device) throws -> Void
) throws -> String {
    guard let selected = select() else { throw CompanionFailure.failed }
    let selectedIdentity = identity(selected)
    observe(selected)
    try capture(selected)
    return selectedIdentity
}

func initializeCapture(
    attempt: () throws -> Void,
    onFailure: () -> Void
) throws {
    do {
        try attempt()
    } catch {
        onFailure()
        throw error
    }
}

@discardableResult
func commitFailedRecordingState(
    persist: () throws -> Void,
    removeAudio: () throws -> Void,
    scheduleRetry: () -> Void
) -> Bool {
    do {
        try persist()
        try removeAudio()
        return true
    } catch {
        scheduleRetry()
        return false
    }
}

private final class RecordingManager {
    private let runtime: String
    private let lock = NSCondition()
    private let ownerLivenessQueue = DispatchQueue(label: "com.yasuhito.pi-dictation.bridge.owner-liveness", qos: .userInitiated)
    private var recordings: [String: BridgeRecording] = [:]
    private var activeId: String?
    private var requests: [String: PersistedRequestReceipt] = [:]
    private var connections: [String: Set<Int32>] = [:]
    private var revokedOwners: Set<String> = []
    private var revocations: [String: PersistedCredentialRevocation] = [:]
    private let upgradeStatePath: String

    init(runtime: String, upgradeStatePath: String) throws {
        self.runtime = runtime
        self.upgradeStatePath = upgradeStatePath
        try restoreRevocations()
        try restore()
        try seedRevocationReceipts()
    }

    private func requestContentHash(clientVersion: Int, operation: String, payload: Data) -> String {
        var digest = SHA256()
        digest.update(data: Data(String(clientVersion).utf8))
        digest.update(data: Data([0]))
        digest.update(data: Data(operation.utf8))
        digest.update(data: Data([0]))
        digest.update(data: payload)
        return Data(digest.finalize()).hex
    }

    func register(ownerId: String, requestId: String, clientVersion: Int, operation: String, payload: Data) throws -> (String, [String: Any])? {
        let contentHash = requestContentHash(clientVersion: clientVersion, operation: operation, payload: payload)
        let key = ownerId + ":" + requestId
        lock.lock()
        defer { lock.unlock() }
        pruneRequestReceiptsLocked()
        if revokedOwners.contains(ownerId) {
            guard let revocation = revocations[ownerId],
                  revocation.requestId == requestId,
                  revocation.contentHash == contentHash else { throw CompanionFailure.notFound }
            return ("ok", revocation.effects)
        }
        if let previous = requests[key] {
            guard previous.contentHash == contentHash else { throw CompanionFailure.requestConflict }
            if previous.responseStatus == "reexecute" { return nil }
            let leaseOperations = ["levels", "subscribe-levels", "status", "stop", "fetch", "cancel", "acknowledge"]
            if leaseOperations.contains(operation), !receiptLeaseExistsLocked(ownerId: ownerId, payload: payload) {
                requests.removeValue(forKey: key)
                do { try persistRequestReceiptsLocked() }
                catch {
                    requests[key] = previous
                    throw error
                }
            } else {
                let deadline = Date().addingTimeInterval(30)
                while requests[key]?.responseStatus == nil {
                    guard lock.wait(until: deadline) else { throw CompanionFailure.failed }
                }
                guard let completed = requests[key], let status = completed.responseStatus else {
                    throw CompanionFailure.failed
                }
                if status == "reexecute" { return nil }
                guard let payload = completed.responsePayload,
                      let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    throw CompanionFailure.failed
                }
                return (status, object)
            }
        }
        if operation == "start" && FileManager.default.fileExists(atPath: upgradeStatePath) {
            throw CompanionFailure.invalidState
        }
        if observationRequestOperations.contains(operation) {
            let observationCount = requests.values.filter {
                $0.ownerId == ownerId && observationRequestOperations.contains($0.operation)
            }.count
            guard observationCount < maximumObservationRequestReceiptsPerCredential else { throw CompanionFailure.failed }
        } else {
            let controlCount = requests.values.filter {
                $0.ownerId == ownerId && !observationRequestOperations.contains($0.operation)
            }.count
            guard controlCount < maximumControlRequestReceiptsPerCredential else { throw CompanionFailure.failed }
        }
        requests[key] = PersistedRequestReceipt(
            ownerId: ownerId, requestId: requestId, clientVersion: clientVersion,
            operation: operation, contentHash: contentHash,
            receivedAt: Date().timeIntervalSince1970, responseStatus: nil, responsePayload: nil
        )
        do { try persistRequestReceiptsLocked() }
        catch {
            requests.removeValue(forKey: key)
            throw error
        }
        return nil
    }

    func openConnection(ownerId: String, descriptor: Int32) throws {
        lock.lock()
        defer { lock.unlock() }
        guard (connections[ownerId]?.count ?? 0) < maximumConnectionsPerCredential else {
            throw CompanionFailure.failed
        }
        connections[ownerId, default: []].insert(descriptor)
    }

    func closeConnection(ownerId: String, descriptor: Int32) {
        lock.lock()
        connections[ownerId]?.remove(descriptor)
        if connections[ownerId]?.isEmpty == true { connections.removeValue(forKey: ownerId) }
        lock.unlock()
    }

    private func receiptLeaseExistsLocked(ownerId: String, payload: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let id = object["recordingId"] as? String,
              let secretText = object["leaseSecret"] as? String,
              let secret = Data(base64Encoded: secretText), secret.count == 32,
              let current = recordings[id], current.ownerId == ownerId else { return false }
        return constantTimeEqual(current.leaseHash, Data(SHA256.hash(data: secret)))
    }

    func recordResponse(ownerId: String, requestId: String, status: String, payload: [String: Any]) throws {
        let key = ownerId + ":" + requestId
        lock.lock()
        defer { lock.unlock() }
        guard var receipt = requests[key] else { throw CompanionFailure.failed }
        if receipt.responseStatus != nil { return }
        if observationRequestOperations.contains(receipt.operation) {
            receipt.responseStatus = "reexecute"
            receipt.responsePayload = nil
        } else {
            receipt.responseStatus = status
            receipt.responsePayload = try jsonData(payload)
        }
        requests[key] = receipt
        do {
            try persistRequestReceiptsLocked()
            lock.broadcast()
        } catch {
            receipt.responseStatus = nil
            receipt.responsePayload = nil
            requests[key] = receipt
            lock.broadcast()
            throw error
        }
    }

    private func effectsLocked(ownerId: String, currentDescriptor: Int32) -> ([BridgeRecording], [Int32], [String: Int]) {
        let owned = recordings.values.filter { $0.ownerId == ownerId }
        let ownedConnections = Array((connections[ownerId] ?? []).filter { $0 != currentDescriptor })
        return (owned, ownedConnections, [
            "connections": ownedConnections.count,
            "activeRecordingLease": owned.filter { ["recording", "finalizing"].contains($0.state) }.count,
            "incompleteAudio": owned.filter {
                $0.state != "result-ready" && FileManager.default.fileExists(atPath: $0.url.path)
            }.count,
            "retainedWav": owned.filter { $0.state == "result-ready" }.count,
        ])
    }

    func credentialEffects(ownerId: String, currentDescriptor: Int32) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return effectsLocked(ownerId: ownerId, currentDescriptor: currentDescriptor).2
    }

    func quiesceCredentialForUpgrade(ownerId: String, currentDescriptor: Int32,
                                     cancelRecordings: Bool) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let (owned, ownedConnections, effects) = effectsLocked(ownerId: ownerId, currentDescriptor: currentDescriptor)
        if !cancelRecordings && ((effects["activeRecordingLease"] ?? 0) > 0 ||
                                 (effects["incompleteAudio"] ?? 0) > 0) {
            throw CompanionFailure.invalidState
        }
        for descriptor in ownedConnections { shutdown(descriptor, SHUT_RDWR) }
        if cancelRecordings { for current in owned { try cleanupRevokedRecordingLocked(current) } }
        return effects
    }

    func revokeCredential(ownerId: String, requestId: String, clientVersion: Int,
                          operation: String, payload: Data, currentDescriptor: Int32,
                          onlyIfIdle: Bool, onlyIfNoActive: Bool = false) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let (owned, ownedConnections, effects) = effectsLocked(ownerId: ownerId, currentDescriptor: currentDescriptor)
        if (onlyIfIdle && ((effects["activeRecordingLease"] ?? 0) > 0 ||
                           (effects["incompleteAudio"] ?? 0) > 0 ||
                           (effects["retainedWav"] ?? 0) > 0)) ||
           (onlyIfNoActive && ((effects["activeRecordingLease"] ?? 0) > 0 ||
                               (effects["incompleteAudio"] ?? 0) > 0)) {
            throw CompanionFailure.invalidState
        }
        let revocation = PersistedCredentialRevocation(
            schemaVersion: 1, ownerId: ownerId, requestId: requestId,
            clientVersion: clientVersion, operation: operation,
            contentHash: requestContentHash(clientVersion: clientVersion, operation: operation, payload: payload),
            effects: effects, revokedAt: Date().timeIntervalSince1970
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try atomicWrite(encoder.encode(revocation), to: revocationPath(ownerId))
        revocations[ownerId] = revocation
        revokedOwners.insert(ownerId)
        for descriptor in ownedConnections { shutdown(descriptor, SHUT_RDWR) }
        do {
            for current in owned { try cleanupRevokedRecordingLocked(current) }
        } catch {
            scheduleRevokedCleanupLocked(ownerId: ownerId)
        }
        return effects
    }

    private func stopDurationWatchdogLocked(_ current: BridgeRecording) {
        current.durationTimer?.cancel()
        current.durationTimer = nil
        current.durationWatchdogRequests?.fileHandleForReading.readabilityHandler = nil
        try? current.durationWatchdogRequests?.fileHandleForReading.close()
        current.durationWatchdogRequests = nil
        if let watchdog = current.durationWatchdog {
            if watchdog.isRunning { watchdog.terminate() }
            current.durationWatchdog = nil
        }
    }

    private func startDurationWatchdogLocked(_ current: BridgeRecording, deadlineUptimeNanoseconds: UInt64) throws {
        let now = DispatchTime.now().uptimeNanoseconds
        let remainingMilliseconds = max(1, Int((deadlineUptimeNanoseconds > now ? deadlineUptimeNanoseconds - now : 0) / 1_000_000))
#if PROTOCOL_TESTING
        if ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_USE_WATCHDOG"] != "1" {
            let expiry = DispatchWorkItem { [weak self, weak current] in
                guard let self, let current else { return }
                self.finalize(current, completion: "duration-limit")
            }
            current.durationTimer = expiry
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(remainingMilliseconds), execute: expiry)
            return
        }
#endif
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("PiDictationDurationWatchdog")
        var info = stat()
        guard lstat(executable.path, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), (info.st_mode & 0o777) == 0o700,
              info.st_nlink == 1 else { throw CompanionFailure.unsafeStorage }
        let token = UUID().uuidString.lowercased()
        let parentProof = Pipe()
        let requests = Pipe()
        let watchdog = Process()
        watchdog.executableURL = executable
        watchdog.arguments = [String(getpid()), String(remainingMilliseconds)]
        watchdog.environment = [:]
        watchdog.currentDirectoryURL = URL(fileURLWithPath: "/")
        watchdog.standardInput = parentProof
        watchdog.standardOutput = requests
        watchdog.standardError = nil
        requests.fileHandleForReading.readabilityHandler = { [weak self, weak current] handle in
            guard let self, let current else { return }
            let data = handle.availableData
            guard !data.isEmpty else { return }
            current.durationWatchdogRequestData.append(data)
            guard current.durationWatchdogRequestData.count <= 64,
                  current.durationWatchdogRequestData.last == 0x0a else { return }
            let value = String(decoding: current.durationWatchdogRequestData.dropLast(), as: UTF8.self)
            guard value == token else { return }
            handle.readabilityHandler = nil
            self.finalize(current, completion: "duration-limit")
        }
        try watchdog.run()
        current.durationWatchdogRequests = requests
        current.durationWatchdog = watchdog
        do {
            try parentProof.fileHandleForWriting.write(contentsOf: Data((token + "\n").utf8))
            try parentProof.fileHandleForWriting.close()
        } catch {
            stopDurationWatchdogLocked(current)
            throw error
        }
    }

    private func removeDeviceObserverLocked(_ current: BridgeRecording) {
        if let observer = current.deviceObserver {
            NotificationCenter.default.removeObserver(observer)
            current.deviceObserver = nil
        }
    }

    private func cleanupRevokedRecordingLocked(_ current: BridgeRecording) throws {
        stopDurationWatchdogLocked(current); current.ownerLivenessTimer?.cancel()
        removeDeviceObserverLocked(current)
        current.retentionTimer?.cancel(); current.levelTimer?.cancel()
        current.levelSubscriber?.close(); current.levelSubscriber = nil
        closeFetchLocked(current)
        current.recorder?.stop(); current.recorder = nil
        try removeAudioLocked(current)
        testCrash("revoke-after-audio-delete")
        let metadata = metadataPath(current.id)
        if FileManager.default.fileExists(atPath: metadata) {
            try FileManager.default.removeItem(atPath: metadata)
            try syncRuntimeDirectory()
        }
        recordings.removeValue(forKey: current.id)
        if activeId == current.id { activeId = nil }
    }

    private func scheduleRevokedCleanupLocked(ownerId: String) {
        let retry = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            do {
                for current in self.recordings.values.filter({ $0.ownerId == ownerId }) {
                    try self.cleanupRevokedRecordingLocked(current)
                }
            } catch {
                self.scheduleRevokedCleanupLocked(ownerId: ownerId)
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: retry)
    }

    func delayAfterRegistrationForTesting(operation: String) {
#if PROTOCOL_TESTING
        guard operation == "start",
              FileManager.default.fileExists(atPath: runtime + "/test-delay-start-after-register") else { return }
        Thread.sleep(forTimeInterval: 0.25)
#endif
    }

    private func testCrash(_ point: String) {
#if PROTOCOL_TESTING
        let marker = runtime + "/test-crash-point"
        let selected = (try? String(contentsOfFile: marker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) ??
            ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_CRASH"]
        if selected == point {
            try? FileManager.default.removeItem(atPath: marker)
            _exit(86)
        }
#endif
    }

    func start(id: String, ownerId: String, leaseSecret: Data, maximumDurationMs: Int) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard !revokedOwners.contains(ownerId) else { throw CompanionFailure.notFound }
        let leaseHash = Data(SHA256.hash(data: leaseSecret))
        if let existing = recordings[id],
           existing.ownerId == ownerId,
           constantTimeEqual(existing.leaseHash, leaseHash) {
            return statusPayload(existing)
        }
        guard activeId == nil else { throw CompanionFailure.busy }
        guard recordings[id] == nil else { throw CompanionFailure.notFound }
        guard maximumDurationMs >= 1000,
              maximumDurationMs <= 60 * 60 * 1000 else { throw CompanionFailure.failed }
#if !PROTOCOL_TESTING
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw CompanionFailure.failed }
#endif
        let (pcmBytes, pcmOverflow) = Int64(maximumDurationMs).multipliedReportingOverflow(by: 32)
        let (maximumBytes, headerOverflow) = pcmBytes.addingReportingOverflow(Int64(maximumWavHeaderBytes))
        guard !pcmOverflow, !headerOverflow, maximumBytes > Int64(maximumWavHeaderBytes) else {
            throw CompanionFailure.failed
        }
        let storageUsage = try storageUsageLocked()
        guard storageUsage.files < maximumRetainedWavFiles,
              maximumBytes <= maximumRetainedWavBytes,
              storageUsage.bytes <= maximumRetainedWavBytes - maximumBytes else {
            throw CompanionFailure.storageFull
        }
        let (admissionCapacity, admissionOverflow) = maximumBytes.multipliedReportingOverflow(by: 2)
        guard !admissionOverflow else { throw CompanionFailure.storageFull }
        let capacity = try URL(fileURLWithPath: runtime).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard capacity >= admissionCapacity else { throw CompanionFailure.storageFull }
        let url = URL(fileURLWithPath: runtime + "/recording-" + id + ".wav")
        var existing = stat()
        guard lstat(url.path, &existing) != 0, errno == ENOENT else { throw CompanionFailure.unsafeStorage }

        let current = BridgeRecording(
            id: id, ownerId: ownerId, leaseHash: leaseHash, url: url,
            maximumResultBytes: maximumBytes
        )
        recordings[id] = current
        activeId = id
        do {
            try createReservationLocked(current)
            try persistLocked(current)
        } catch {
            try? releaseReservationLocked(current)
            recordings.removeValue(forKey: id)
            activeId = nil
            throw error
        }
        testCrash("start-after-reservation")
        try initializeCapture(
            attempt: {
#if PROTOCOL_TESTING
                if ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_FAIL_CAPTURE"] == "1" {
                    throw CompanionFailure.failed
                }
                try writeProtocolTestingWav(to: url)
                current.captureStartedAtUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
#else
                _ = try withPinnedDefaultInput(
                    select: { AVCaptureDevice.default(for: .audio) },
                    identity: { $0.uniqueID },
                    observe: { pinnedDevice in
                        current.deviceObserver = NotificationCenter.default.addObserver(
                            forName: AVCaptureDevice.wasDisconnectedNotification,
                            object: pinnedDevice,
                            queue: nil
                        ) { [weak self, weak current] _ in
                            guard let self, let current else { return }
                            self.failIfActive(current, reason: "device-loss")
                        }
                    },
                    capture: { pinnedDevice in
                        let settings: [String: Any] = [
                            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000.0,
                            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                        ]
                        guard AVCaptureDevice.default(for: .audio)?.uniqueID == pinnedDevice.uniqueID else {
                            throw CompanionFailure.failed
                        }
                        let audioRecorder = try AVAudioRecorder(url: url, settings: settings)
                        guard audioRecorder.prepareToRecord(), chmod(url.path, S_IRUSR | S_IWUSR) == 0,
                              audioRecorder.record(),
                              AVCaptureDevice.default(for: .audio)?.uniqueID == pinnedDevice.uniqueID else {
                            throw CompanionFailure.failed
                        }
                        current.recorder = audioRecorder
                        current.captureStartedAtUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
                    }
                )
#endif
            },
            onFailure: { self.failLocked(current) }
        )
        guard let captureStartedAt = current.captureStartedAtUptimeNanoseconds else {
            failLocked(current)
            throw CompanionFailure.failed
        }
#if PROTOCOL_TESTING
        if let delayText = ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_POST_CAPTURE_DELAY_MS"],
           let delay = UInt32(delayText), delay > 0 {
            usleep(delay * 1_000)
        }
#endif
        let durationDeadline = captureStartedAt + UInt64(maximumDurationMs) * 1_000_000
        do { try startDurationWatchdogLocked(current, deadlineUptimeNanoseconds: durationDeadline) }
        catch {
            failLocked(current)
            throw error
        }

        let levels = DispatchSource.makeTimerSource(queue: .global())
#if PROTOCOL_TESTING
        let levelStartDelay = Int(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_LEVEL_START_DELAY_MS"] ?? "") ?? 50
#else
        let levelStartDelay = 50
#endif
        levels.schedule(deadline: .now() + .milliseconds(levelStartDelay), repeating: .milliseconds(50))
        levels.setEventHandler { [weak self, weak current] in
            guard let self, let current else { return }
            self.captureLevel(current)
        }
        current.levelTimer = levels
        levels.resume()
        current.lastOwnerProofUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
        let liveness = DispatchSource.makeTimerSource(queue: ownerLivenessQueue)
        liveness.setEventHandler { [weak self, weak current] in
            guard let self, let current else { return }
            self.enforceOwnerLiveness(current)
        }
        current.ownerLivenessTimer = liveness
        scheduleOwnerLivenessExpiryLocked(current, after: initialOwnerLivenessSeconds)
        liveness.resume()
        return statusPayload(current)
    }

    func enforceDurationLimit() {
        lock.lock()
        let current = activeId.flatMap { recordings[$0] }
        lock.unlock()
        if let current { finalize(current, completion: "duration-limit") }
    }

    func failActive(reason: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let activeId, let current = recordings[activeId], current.state == "recording" else { return }
        failLocked(current, reason: reason)
    }

    private func failIfActive(_ current: BridgeRecording, reason: String) {
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "recording", activeId == current.id else { return }
        failLocked(current, reason: reason)
    }

    private func scheduleOwnerLivenessExpiryLocked(_ current: BridgeRecording, after seconds: TimeInterval = ownerLivenessSeconds) {
        current.ownerLivenessTimer?.schedule(deadline: .now() + seconds)
    }

    private func enforceOwnerLiveness(_ current: BridgeRecording) {
        lock.lock()
        guard current.state == "recording", activeId == current.id else {
            lock.unlock()
            return
        }
        let now = DispatchTime.now().uptimeNanoseconds
        let elapsedNanoseconds = now >= current.lastOwnerProofUptimeNanoseconds
            ? now - current.lastOwnerProofUptimeNanoseconds : UInt64.max
        let deadlineNanoseconds = UInt64(ownerLivenessSeconds * 1_000_000_000)
        if elapsedNanoseconds < deadlineNanoseconds {
            let remaining = Double(deadlineNanoseconds - elapsedNanoseconds) / 1_000_000_000
            current.ownerLivenessTimer?.schedule(deadline: .now() + remaining)
            lock.unlock()
            return
        }
        lock.unlock()
        finalize(current, completion: "owner-liveness-loss")
    }

    private func captureLevel(_ current: BridgeRecording) {
        current.levelReaderLock.lock()
        lock.lock()
        guard current.state == "recording", activeId == current.id else {
            lock.unlock(); current.levelReaderLock.unlock(); return
        }
        let startingSequence = current.sequence
        lock.unlock()
        let result = Result { try current.levelReader.readIntervals(startingAt: startingSequence) }
        if case .failure = result { current.levelReader.markUnavailableInterval() }
        lock.lock()
        guard ["recording", "finalizing"].contains(current.state), current.sequence == startingSequence else {
            lock.unlock(); current.levelReaderLock.unlock(); return
        }
        switch result {
        case .failure:
            let event: [String: Any] = [
                "type": "unavailable", "sequence": current.sequence,
                "capturedAtMs": current.sequence * levelIntervalMilliseconds,
            ]
            current.sequence += 1
            current.observations.append(event)
            if current.observations.count > levelReplaySlots {
                current.observations.removeFirst(current.observations.count - levelReplaySlots)
            }
            let subscriber = current.levelSubscriber
            lock.unlock()
            current.levelReaderLock.unlock()
            subscriber?.enqueue(event)
        case .success(let events):
            current.sequence += events.count
            current.observations.append(contentsOf: events)
            if current.observations.count > levelReplaySlots {
                current.observations.removeFirst(current.observations.count - levelReplaySlots)
            }
            let subscriber = current.levelSubscriber
            lock.unlock()
            current.levelReaderLock.unlock()
            for event in events { subscriber?.enqueue(event) }
        }
    }

    func levels(id: String, ownerId: String, leaseSecret: Data, after: Int) throws -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        guard current.state == "recording" else { throw CompanionFailure.invalidState }
        return Array(current.observations.filter {
            ($0["sequence"] as? Int ?? -1) > after
        }.prefix(maximumDiagnosticLevelObservations))
    }

    func subscribe(id: String, ownerId: String, leaseSecret: Data, after: Int,
                   subscriber: LevelSubscriber) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        guard current.state == "recording" else { throw CompanionFailure.invalidState }
        let oldest = current.observations.first?["sequence"] as? Int ?? current.sequence
        let replay = current.observations.filter { ($0["sequence"] as? Int ?? -1) > after }
        current.levelSubscriber?.close()
        current.levelSubscriber = subscriber
        for event in replay { subscriber.enqueueReplay(event) }
        return [
            "recordingId": current.id, "intervalMs": levelIntervalMilliseconds,
            "oldestSequence": oldest, "nextSequence": current.sequence,
        ]
    }

    func status(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        if current.state == "recording" {
            current.lastOwnerProofUptimeNanoseconds = DispatchTime.now().uptimeNanoseconds
            scheduleOwnerLivenessExpiryLocked(current)
        }
        return statusPayload(current)
    }

    func stop(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        let current: BridgeRecording
        do { current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret) }
        catch { lock.unlock(); throw error }
        if current.state == "result-ready" {
            let payload = statusPayload(current)
            lock.unlock()
            return payload
        }
        guard current.state == "recording" else {
            lock.unlock()
            throw CompanionFailure.invalidState
        }
        do { try beginFinalizationLocked(current, completion: "stopped") }
        catch {
            failLocked(current)
            lock.unlock()
            throw CompanionFailure.failed
        }
        lock.unlock()
        completeFinalization(current)
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "result-ready" || current.state == "finalizing" else { throw CompanionFailure.invalidState }
        return statusPayload(current)
    }

    func beginFetch(id: String, ownerId: String, leaseSecret: Data, descriptor: Int32) throws -> (payload: [String: Any], url: URL) {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        guard current.state == "result-ready", current.activeFetchDescriptor == nil else {
            throw CompanionFailure.invalidState
        }
        current.activeFetchDescriptor = descriptor
        return (statusPayload(current).filter { $0.key != "state" }, current.url)
    }

    func endFetch(id: String, descriptor: Int32) {
        lock.lock()
        if recordings[id]?.activeFetchDescriptor == descriptor {
            recordings[id]?.activeFetchDescriptor = nil
        }
        lock.unlock()
    }

    private func closeFetchLocked(_ current: BridgeRecording) {
        if let descriptor = current.activeFetchDescriptor {
            current.activeFetchDescriptor = nil
            shutdown(descriptor, SHUT_RDWR)
        }
    }

    func cancel(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        if current.state == "cancelled" {
            do { try removeAudioLocked(current) }
            catch { scheduleCleanupRetryLocked(current); throw error }
            return statusPayload(current)
        }
        guard ["recording", "finalizing", "result-ready"].contains(current.state) else { throw CompanionFailure.invalidState }
        let terminalAt = Date().timeIntervalSince1970
        try persistTransitionLocked(current, state: "cancelled", terminalAt: terminalAt)
        stopDurationWatchdogLocked(current); current.ownerLivenessTimer?.cancel()
        current.retentionTimer?.cancel(); current.levelTimer?.cancel()
        removeDeviceObserverLocked(current)
        closeFetchLocked(current)
        current.recorder?.stop()
        current.recorder = nil
        current.levelSubscriber?.enqueue(["type": "terminal", "state": "cancelled"])
        current.levelSubscriber = nil
        if activeId == current.id { activeId = nil }
        current.state = "cancelled"; current.length = nil; current.sha256 = nil
        current.terminalAt = terminalAt
        do {
            try removeAudioLocked(current)
            testCrash("cancel-after-audio-delete")
            scheduleRetentionLocked(current)
        } catch {
            scheduleCleanupRetryLocked(current)
        }
        return statusPayload(current)
    }

    func acknowledge(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        if current.state == "acknowledged" {
            do { try removeAudioLocked(current) }
            catch { scheduleCleanupRetryLocked(current); throw error }
            return statusPayload(current)
        }
        guard current.state == "result-ready", current.activeFetchDescriptor == nil else {
            throw CompanionFailure.invalidState
        }
        let terminalAt = Date().timeIntervalSince1970
        try persistTransitionLocked(current, state: "acknowledged", terminalAt: terminalAt)
        current.retentionTimer?.cancel()
        current.state = "acknowledged"; current.length = nil; current.sha256 = nil
        current.terminalAt = terminalAt
        do {
            try removeAudioLocked(current)
            testCrash("acknowledge-after-audio-delete")
            scheduleRetentionLocked(current)
        } catch {
            scheduleCleanupRetryLocked(current)
        }
        return statusPayload(current)
    }

    private func owned(id: String, ownerId: String, leaseSecret: Data) throws -> BridgeRecording {
        let supplied = Data(SHA256.hash(data: leaseSecret))
        let expected = recordings[id]?.leaseHash ?? Data(repeating: 0, count: 32)
        let matches = constantTimeEqual(expected, supplied)
        guard let current = recordings[id], current.ownerId == ownerId, matches else { throw CompanionFailure.notFound }
        enforceRetentionLocked(current)
        guard recordings[id] != nil else { throw CompanionFailure.notFound }
        return current
    }

    private func statusPayload(_ current: BridgeRecording) -> [String: Any] {
        var payload: [String: Any] = ["recordingId": current.id, "state": current.state]
        if current.state == "result-ready", let length = current.length, let sha256 = current.sha256 {
            payload["length"] = length; payload["sha256"] = sha256; payload["completion"] = current.completion
        } else if current.state == "failed", let reason = current.failureReason {
            payload["reason"] = reason
        }
        return payload
    }

    private func finalize(_ current: BridgeRecording, completion: String) {
        lock.lock()
        guard current.state == "recording" else { lock.unlock(); return }
        do { try beginFinalizationLocked(current, completion: completion) }
        catch {
            failLocked(current)
            lock.unlock()
            return
        }
        lock.unlock()
        completeFinalization(current)
    }

    private func beginFinalizationLocked(_ current: BridgeRecording, completion: String) throws {
        current.completion = completion
        stopDurationWatchdogLocked(current); current.ownerLivenessTimer?.cancel(); current.levelTimer?.cancel()
        removeDeviceObserverLocked(current)
        current.recorder?.stop()
        current.recorder = nil
        current.state = "finalizing"
        try persistLocked(current)
    }

    private func completeFinalization(_ current: BridgeRecording) {
#if PROTOCOL_TESTING
        if let delayText = ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_FINALIZATION_DELAY_MS"],
           let delay = UInt32(delayText), delay > 0 {
            usleep(delay * 1_000)
        }
#endif
        current.levelReaderLock.lock()
        lock.lock()
        let startingSequence = current.sequence
        let shouldDrain = current.state == "finalizing"
        lock.unlock()
        let finalEvents = shouldDrain ? (try? current.levelReader.readIntervals(startingAt: startingSequence)) : nil
        lock.lock()
        if current.state == "finalizing", current.sequence == startingSequence, let finalEvents {
            current.sequence += finalEvents.count
            current.observations.append(contentsOf: finalEvents)
            if current.observations.count > levelReplaySlots {
                current.observations.removeFirst(current.observations.count - levelReplaySlots)
            }
            for event in finalEvents { current.levelSubscriber?.enqueue(event) }
        }
        if current.state == "finalizing" {
            current.levelSubscriber?.enqueue(["type": "terminal", "state": "finalizing"])
            current.levelSubscriber = nil
        }
        lock.unlock()
        current.levelReaderLock.unlock()

        var result: (Int, String)?
        do {
            let size = try validateFinalizedWav(current.url, maximumResultBytes: current.maximumResultBytes)
            try syncResultFile(current.url)
            result = (size, try fileDigest(current.url))
        } catch {}
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "finalizing" else { return }
        if let result {
            do { try releaseReservationLocked(current) }
            catch { failLocked(current); return }
            current.length = result.0; current.sha256 = result.1; current.state = "result-ready"
            current.terminalAt = Date().timeIntervalSince1970
            do { try persistLocked(current) }
            catch { failLocked(current); return }
        } else {
            failLocked(current)
            return
        }
        if activeId == current.id { activeId = nil }
        scheduleRetentionLocked(current)
    }

    private func failLocked(_ current: BridgeRecording, reason: String = "capture-failure") {
        stopDurationWatchdogLocked(current); current.ownerLivenessTimer?.cancel(); current.levelTimer?.cancel()
        removeDeviceObserverLocked(current)
        current.recorder?.stop()
        current.recorder = nil
        current.levelSubscriber?.enqueue(["type": "terminal", "state": "failed"])
        current.levelSubscriber = nil
        current.state = "failed"; current.length = nil; current.sha256 = nil
        current.failureReason = reason
        current.terminalAt = Date().timeIntervalSince1970
        if activeId == current.id { activeId = nil }
        let committed = commitFailedRecordingState(
            persist: { try self.persistLocked(current) },
            removeAudio: { try self.removeAudioLocked(current) },
            scheduleRetry: { self.scheduleCleanupRetryLocked(current) }
        )
        if committed { scheduleRetentionLocked(current) }
    }

    private func reservationPath(_ id: String) -> String { runtime + "/recording-" + id + ".reserve" }

    private func managedArtifactSize(_ path: String) throws -> Int64? {
        var info = stat()
        if lstat(path, &info) != 0 {
            guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
            return nil
        }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
              (info.st_mode & 0o777) == 0o600, info.st_nlink == 1,
              info.st_size >= 0 else { throw CompanionFailure.unsafeStorage }
        return Int64(info.st_size)
    }

    private func storageUsageLocked() throws -> (files: Int, bytes: Int64) {
        var files = 0
        var bytes: Int64 = 0
        for current in recordings.values {
            let wavBytes = try managedArtifactSize(current.url.path)
            let reservationBytes = try managedArtifactSize(reservationPath(current.id))
            guard wavBytes != nil || reservationBytes != nil else { continue }
            files += 1
            let chargedBytes = reservationBytes.map { max($0, current.maximumResultBytes) } ?? wavBytes!
            let (total, overflow) = bytes.addingReportingOverflow(chargedBytes)
            guard !overflow else { throw CompanionFailure.storageFull }
            bytes = total
        }
        return (files, bytes)
    }

    private func createReservationLocked(_ current: BridgeRecording) throws {
#if PROTOCOL_TESTING
        if ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_FAIL_RESERVATION"] == "1" {
            throw CompanionFailure.storageFull
        }
#endif
        let path = reservationPath(current.id)
        let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            if errno == ENOSPC || errno == EDQUOT { throw CompanionFailure.storageFull }
            throw CompanionFailure.unsafeStorage
        }
        var complete = false
        defer {
            Darwin.close(descriptor)
            if !complete { unlink(path) }
        }
        var store = fstore_t(
            fst_flags: UInt32(F_ALLOCATECONTIG), fst_posmode: Int32(F_PEOFPOSMODE),
            fst_offset: 0, fst_length: off_t(current.maximumResultBytes), fst_bytesalloc: 0
        )
        recordResourceMetric("reservationRequested", bytes: Int(current.maximumResultBytes))
        let contiguousResult = fcntl(descriptor, F_PREALLOCATE, &store)
        if contiguousResult != 0 || store.fst_bytesalloc < off_t(current.maximumResultBytes) {
            store.fst_flags = UInt32(F_ALLOCATEALL)
            store.fst_bytesalloc = 0
            guard fcntl(descriptor, F_PREALLOCATE, &store) == 0 else {
                recordResourceMetric("reservationErrno", bytes: Int(errno))
                throw CompanionFailure.storageFull
            }
        }
        recordResourceMetric("reservationAllocated", bytes: Int(store.fst_bytesalloc))
        guard store.fst_bytesalloc >= off_t(current.maximumResultBytes),
              ftruncate(descriptor, off_t(current.maximumResultBytes)) == 0,
              fsync(descriptor) == 0 else {
            recordResourceMetric("reservationFinalizeErrno", bytes: Int(errno))
            throw CompanionFailure.storageFull
        }
        complete = true
        try syncRuntimeDirectory()
    }

    private func releaseReservationLocked(_ current: BridgeRecording) throws {
        let path = reservationPath(current.id)
        var info = stat()
        if lstat(path, &info) != 0 {
            guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
            return
        }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
              (info.st_mode & 0o777) == 0o600, info.st_nlink == 1,
              unlink(path) == 0 else { throw CompanionFailure.unsafeStorage }
        try syncRuntimeDirectory()
    }

    private func removeAudioLocked(_ current: BridgeRecording) throws {
#if PROTOCOL_TESTING
        let failureMarker = runtime + "/test-fail-audio-cleanup"
        let persistentFailureMarker = runtime + "/test-always-fail-audio-cleanup"
        if FileManager.default.fileExists(atPath: persistentFailureMarker) {
            throw CompanionFailure.failed
        }
        if FileManager.default.fileExists(atPath: failureMarker) {
            try? FileManager.default.removeItem(atPath: failureMarker)
            throw CompanionFailure.failed
        }
#endif
        if FileManager.default.fileExists(atPath: current.url.path) {
            try FileManager.default.removeItem(at: current.url)
            try syncRuntimeDirectory()
        }
        try releaseReservationLocked(current)
        guard !FileManager.default.fileExists(atPath: current.url.path),
              !FileManager.default.fileExists(atPath: reservationPath(current.id)) else {
            throw CompanionFailure.unsafeStorage
        }
    }

    private func expireLocked(_ current: BridgeRecording) {
        guard current.state == "result-ready" else { return }
        closeFetchLocked(current)
        let completedAt = current.terminalAt ?? Date().timeIntervalSince1970
        current.state = "expired"; current.length = nil; current.sha256 = nil
        current.terminalAt = completedAt + resultRetentionSeconds
        do {
            try persistLocked(current)
            try removeAudioLocked(current)
            testCrash("retention-after-audio-delete")
            scheduleRetentionLocked(current)
        } catch {
            scheduleCleanupRetryLocked(current)
        }
    }

    private func enforceRetentionLocked(_ current: BridgeRecording) {
        guard let terminalAt = current.terminalAt else { return }
        guard Date().timeIntervalSince1970 - terminalAt >= resultRetentionSeconds else { return }
        if current.state == "result-ready" {
            expireLocked(current)
            if let expiredAt = current.terminalAt,
               Date().timeIntervalSince1970 - expiredAt >= resultRetentionSeconds {
                purgeLocked(current)
            }
        } else {
            purgeLocked(current)
        }
    }

    private func purgeLocked(_ current: BridgeRecording) {
        do {
            try removeAudioLocked(current)
            let metadata = metadataPath(current.id)
            if FileManager.default.fileExists(atPath: metadata) {
                try FileManager.default.removeItem(atPath: metadata)
                try syncRuntimeDirectory()
            }
            recordings.removeValue(forKey: current.id)
        } catch {
            scheduleCleanupRetryLocked(current)
        }
    }

    private func scheduleRetentionLocked(_ current: BridgeRecording) {
        current.retentionTimer?.cancel()
        guard let terminalAt = current.terminalAt else { return }
        let now = Date().timeIntervalSince1970
        let elapsed = terminalAt <= now ? now - terminalAt : resultRetentionSeconds
        let remaining = max(0, resultRetentionSeconds - elapsed)
        let expectedState = current.state
        let expectedTerminalAt = terminalAt
        let work = DispatchWorkItem { [weak self, weak current] in
            guard let self, let current else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard current.state == expectedState, current.terminalAt == expectedTerminalAt else { return }
            if expectedState == "result-ready" {
                self.expireLocked(current)
            } else {
                self.purgeLocked(current)
            }
        }
        current.retentionTimer = work
        DispatchQueue.global().asyncAfter(deadline: .now() + remaining, execute: work)
    }

    private func scheduleCleanupRetryLocked(_ current: BridgeRecording) {
        current.retentionTimer?.cancel()
        let expectedState = current.state
        let retry = DispatchWorkItem { [weak self, weak current] in
            guard let self, let current else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard current.state == expectedState else { return }
            do {
                try self.persistLocked(current)
                try self.removeAudioLocked(current)
                self.scheduleRetentionLocked(current)
            } catch {
                self.scheduleCleanupRetryLocked(current)
            }
        }
        current.retentionTimer = retry
        DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: retry)
    }

    private func metadataPath(_ id: String) -> String { runtime + "/recording-" + id + ".json" }
    private func revocationPath(_ ownerId: String) -> String { runtime + "/revocation-" + ownerId + ".json" }
    private var requestReceiptsPath: String { runtime + "/request-receipts.json" }

    private func restoreRevocations() throws {
        let manager = FileManager.default
        for name in try manager.contentsOfDirectory(atPath: runtime)
            where name.range(of: "^revocation-[0-9A-Fa-f-]{36}\\.json$", options: .regularExpression) != nil {
            let ownerId = String(name.dropFirst("revocation-".count).dropLast(".json".count))
            let data = try readPrivateData(runtime + "/" + name, maximumBytes: maximumFrameBytes)
            let value = try JSONDecoder().decode(PersistedCredentialRevocation.self, from: data)
            let effectKeys = Set(["connections", "activeRecordingLease", "incompleteAudio", "retainedWav"])
            guard value.schemaVersion == 1, value.ownerId == ownerId, canonicalUUID(ownerId),
                  canonicalUUID(value.requestId), value.clientVersion >= 1,
                  ["credential-revoke", "credential-revoke-if-idle", "credential-revoke-if-no-active"].contains(value.operation),
                  value.contentHash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  Set(value.effects.keys) == effectKeys,
                  value.effects.values.allSatisfy({ $0 >= 0 && $0 <= 100_000 }),
                  value.revokedAt.isFinite, revocations[ownerId] == nil else {
                throw CompanionFailure.unsafeStorage
            }
            revocations[ownerId] = value
            revokedOwners.insert(ownerId)
        }
    }

    private func seedRevocationReceipts() throws {
        for value in revocations.values {
            let key = value.ownerId + ":" + value.requestId
            if let existing = requests[key], existing.contentHash != value.contentHash {
                throw CompanionFailure.unsafeStorage
            }
            requests[key] = PersistedRequestReceipt(
                ownerId: value.ownerId, requestId: value.requestId,
                clientVersion: value.clientVersion, operation: value.operation,
                contentHash: value.contentHash, receivedAt: value.revokedAt,
                responseStatus: "ok", responsePayload: try jsonData(value.effects)
            )
        }
        if !revocations.isEmpty { try persistRequestReceiptsLocked() }
    }

    private func persistedValue(_ current: BridgeRecording) -> PersistedRecording {
        PersistedRecording(
            schemaVersion: 2, id: current.id, ownerId: current.ownerId,
            leaseHash: current.leaseHash.base64EncodedString(),
            maximumResultBytes: current.maximumResultBytes, state: current.state,
            length: current.length, sha256: current.sha256,
            completion: ["recording", "finalizing", "result-ready"].contains(current.state) ? current.completion : nil,
            failureReason: current.state == "failed" ? current.failureReason : nil,
            terminalAt: current.terminalAt
        )
    }

    private func persistTransitionLocked(_ current: BridgeRecording, state: String, terminalAt: TimeInterval) throws {
        let value = PersistedRecording(
            schemaVersion: 2, id: current.id, ownerId: current.ownerId,
            leaseHash: current.leaseHash.base64EncodedString(),
            maximumResultBytes: current.maximumResultBytes, state: state,
            length: nil, sha256: nil, completion: nil, failureReason: nil, terminalAt: terminalAt
        )
        try persistLocked(value, id: current.id)
    }

    private func persistLocked(_ current: BridgeRecording) throws {
        try persistLocked(persistedValue(current), id: current.id)
    }

    private func persistLocked(_ value: PersistedRecording, id: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try atomicWrite(encoder.encode(value), to: metadataPath(id))
    }

    private func pruneRequestReceiptsLocked() {
        let cutoff = Date().timeIntervalSince1970 - requestReceiptRetentionSeconds
        let current = requests.values.filter { $0.receivedAt >= cutoff }
        requests = Dictionary(uniqueKeysWithValues: current.map {
            ($0.ownerId + ":" + $0.requestId, $0)
        })
    }

    private func persistRequestReceiptsLocked() throws {
        pruneRequestReceiptsLocked()
        let value = PersistedRequestRegistry(
            schemaVersion: 4,
            receipts: requests.values.sorted { $0.receivedAt < $1.receivedAt }
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        let pendingControlCount = requests.values.filter {
            !observationRequestOperations.contains($0.operation) && $0.responseStatus == nil
        }.count
        let pendingObservationCount = requests.values.filter {
            observationRequestOperations.contains($0.operation) && $0.responseStatus == nil
        }.count
        let reservedResponseBytes = pendingControlCount * maximumFrameBytes * 2 + pendingObservationCount * 64
        guard data.count + reservedResponseBytes <= maximumRequestRegistryBytes else { throw CompanionFailure.failed }
        try atomicWrite(data, to: requestReceiptsPath)
    }

    private func atomicWrite(_ data: Data, to path: String) throws {
        let temporary = path + ".tmp-" + UUID().uuidString
        try writeExclusive(data, to: temporary)
        guard rename(temporary, path) == 0 else {
            unlink(temporary)
            throw CompanionFailure.unsafeStorage
        }
        try syncRuntimeDirectory()
    }

    private func syncRuntimeDirectory() throws {
        let directory = open(runtime, O_RDONLY | O_DIRECTORY)
        guard directory >= 0 else { throw CompanionFailure.unsafeStorage }
        defer { Darwin.close(directory) }
        guard fsync(directory) == 0 else { throw CompanionFailure.unsafeStorage }
    }

    private func restore() throws {
        let manager = FileManager.default
        let names = try manager.contentsOfDirectory(atPath: runtime)
        var removedTemporary = false
        for name in names where
            name.range(of: "^recording-[0-9A-Fa-f-]{36}\\.json\\.tmp-[0-9A-Fa-f-]{36}$", options: .regularExpression) != nil ||
            name.range(of: "^request-receipts\\.json\\.tmp-[0-9A-Fa-f-]{36}$", options: .regularExpression) != nil ||
            name.range(of: "^revocation-[0-9A-Fa-f-]{36}\\.json\\.tmp-[0-9A-Fa-f-]{36}$", options: .regularExpression) != nil {
            try manager.removeItem(atPath: runtime + "/" + name)
            removedTemporary = true
        }
        if removedTemporary { try syncRuntimeDirectory() }
        if manager.fileExists(atPath: requestReceiptsPath) {
            let data = try readPrivateData(requestReceiptsPath, maximumBytes: maximumRequestRegistryBytes)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let schemaVersion = jsonInteger(object["schemaVersion"]) else { throw CompanionFailure.unsafeStorage }
            if [2, 3].contains(schemaVersion) {
                requests.removeAll()
                try persistRequestReceiptsLocked()
            } else {
                let registry = try JSONDecoder().decode(PersistedRequestRegistry.self, from: data)
                guard registry.schemaVersion == 4 else { throw CompanionFailure.unsafeStorage }
                let validStatuses = ["ok", "busy", "not-found", "request-conflict", "invalid-state", "failed", "version-mismatch", "reexecute"]
                var restoredKeys = Set<String>()
                for receipt in registry.receipts {
                    let key = receipt.ownerId + ":" + receipt.requestId
                    let responseShapeIsValid = receipt.responseStatus == nil && receipt.responsePayload == nil ||
                        receipt.responseStatus == "reexecute" && receipt.responsePayload == nil ||
                        receipt.responseStatus.map { validStatuses.contains($0) } == true && receipt.responsePayload != nil
                    let responsePayloadIsValid = receipt.responsePayload.map {
                        ((try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]) != nil
                    } ?? true
                    guard UUID(uuidString: receipt.ownerId) != nil,
                          UUID(uuidString: receipt.requestId) != nil,
                          receipt.clientVersion >= 1,
                          !receipt.operation.isEmpty,
                          receipt.operation.utf8.count <= maximumFrameBytes,
                          receipt.contentHash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                          receipt.receivedAt.isFinite,
                          receipt.receivedAt <= Date().timeIntervalSince1970 + 60,
                          responseShapeIsValid, responsePayloadIsValid,
                          receipt.responsePayload.map({ $0.count <= maximumFrameBytes }) ?? true,
                          restoredKeys.insert(key).inserted else { throw CompanionFailure.unsafeStorage }
                    if receipt.responseStatus != nil { requests[key] = receipt }
                }
                for ownerId in Set(requests.values.map(\.ownerId)) {
                    guard requests.values.filter({ $0.ownerId == ownerId && observationRequestOperations.contains($0.operation) }).count <= maximumObservationRequestReceiptsPerCredential,
                          requests.values.filter({ $0.ownerId == ownerId && !observationRequestOperations.contains($0.operation) }).count <= maximumControlRequestReceiptsPerCredential else {
                        throw CompanionFailure.unsafeStorage
                    }
                }
                pruneRequestReceiptsLocked()
                if requests.count != registry.receipts.count { try persistRequestReceiptsLocked() }
            }
        }
        let metadataNames = names.filter {
            $0.range(of: "^recording-[0-9A-Fa-f-]{36}\\.json$", options: .regularExpression) != nil
        }
        for name in metadataNames {
            let path = runtime + "/" + name
            let data = try readPrivateData(path, maximumBytes: maximumFrameBytes)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(["schemaVersion", "id", "ownerId", "leaseHash", "maximumResultBytes", "state", "length", "sha256", "completion", "failureReason", "terminalAt"]).isSuperset(of: Set(object.keys)),
                  Set(["schemaVersion", "id", "ownerId", "leaseHash", "state"]).isSubset(of: Set(object.keys)) else {
                throw CompanionFailure.unsafeStorage
            }
            let persisted = try JSONDecoder().decode(PersistedRecording.self, from: data)
            let terminalStates = ["acknowledged", "cancelled", "expired", "failed"]
            let validFailureReasons = ["capture-failure", "sleep", "logout", "reboot", "session-lock", "companion-stop", "companion-restart", "device-loss"]
            let validShape = persisted.state == "result-ready"
                ? (persisted.length ?? 0) >= 44 && persisted.sha256?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil &&
                  ["stopped", "duration-limit", "owner-liveness-loss"].contains(persisted.completion ?? "") &&
                  persisted.failureReason == nil && persisted.terminalAt != nil
                : terminalStates.contains(persisted.state)
                    ? persisted.length == nil && persisted.sha256 == nil && persisted.completion == nil &&
                      (persisted.state == "failed" ? validFailureReasons.contains(persisted.failureReason ?? "") : persisted.failureReason == nil) &&
                      persisted.terminalAt != nil
                    : persisted.length == nil && persisted.sha256 == nil && persisted.failureReason == nil && persisted.terminalAt == nil
            let legacyLength = Int64(persisted.length ?? 0)
            let legacyMaximum = legacyLength <= maximumRetainedWavBytes - Int64(maximumWavHeaderBytes)
                ? legacyLength + Int64(maximumWavHeaderBytes) : maximumRetainedWavBytes
            let restoredMaximum = persisted.maximumResultBytes ?? legacyMaximum
            guard [1, 2].contains(persisted.schemaVersion),
                  restoredMaximum >= Int64(persisted.length ?? 0),
                  restoredMaximum <= maximumRetainedWavBytes,
                  UUID(uuidString: persisted.id) != nil,
                  name == "recording-" + persisted.id + ".json",
                  UUID(uuidString: persisted.ownerId) != nil,
                  let leaseHash = Data(base64Encoded: persisted.leaseHash), leaseHash.count == 32,
                  ["recording", "finalizing", "result-ready", "acknowledged", "cancelled", "expired", "failed"].contains(persisted.state),
                  validShape, recordings[persisted.id] == nil else { throw CompanionFailure.unsafeStorage }
            let current = BridgeRecording(
                id: persisted.id, ownerId: persisted.ownerId, leaseHash: leaseHash,
                url: URL(fileURLWithPath: runtime + "/recording-" + persisted.id + ".wav"),
                maximumResultBytes: restoredMaximum, state: persisted.state,
                length: persisted.length, sha256: persisted.sha256,
                completion: persisted.completion ?? "stopped", failureReason: persisted.failureReason,
                terminalAt: persisted.terminalAt
            )
            recordings[current.id] = current
            if revokedOwners.contains(current.ownerId) {
                do { try cleanupRevokedRecordingLocked(current) }
                catch { scheduleRevokedCleanupLocked(ownerId: current.ownerId) }
                continue
            }
            if ["recording", "finalizing"].contains(current.state) {
                recoverAsFailedLocked(current)
            } else if current.state == "result-ready" {
                guard let length = current.length, let sha256 = current.sha256,
                      (try? validateResultFile(
                        current.url, length: length, maximumResultBytes: current.maximumResultBytes, sha256: sha256
                      )) == true,
                      current.terminalAt != nil else {
                    recoverAsFailedLocked(current)
                    continue
                }
                enforceRetentionLocked(current)
                if recordings[current.id] != nil { scheduleRetentionLocked(current) }
            } else {
                do { try removeAudioLocked(current) }
                catch {
                    scheduleCleanupRetryLocked(current)
                    continue
                }
                guard current.terminalAt != nil else { throw CompanionFailure.unsafeStorage }
                enforceRetentionLocked(current)
                if recordings[current.id] != nil { scheduleRetentionLocked(current) }
            }
        }
        let restoredReservations = recordings.values.filter {
            ["recording", "finalizing", "result-ready"].contains($0.state)
        }
        let restoredReservedBytes = restoredReservations.reduce(Int64(0)) { partial, recording in
            partial + (recording.state == "result-ready" ? Int64(recording.length ?? 0) : recording.maximumResultBytes)
        }
        guard restoredReservations.count <= maximumRetainedWavFiles,
              restoredReservedBytes <= maximumRetainedWavBytes else {
            throw CompanionFailure.unsafeStorage
        }
        let known = Set(recordings.keys.map { "recording-" + $0 + ".wav" })
        var removedOrphan = false
        for name in names where name.range(of: "^recording-[0-9A-Fa-f-]{36}\\.wav$", options: .regularExpression) != nil && !known.contains(name) {
            let path = runtime + "/" + name
            if manager.fileExists(atPath: path) {
                try manager.removeItem(atPath: path)
                removedOrphan = true
            }
        }
        for name in names where name.range(of: "^recording-[0-9A-Fa-f-]{36}\\.reserve$", options: .regularExpression) != nil {
            let path = runtime + "/" + name
            var info = stat()
            if lstat(path, &info) != 0 {
                guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
                continue
            }
            guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
                  (info.st_mode & 0o777) == 0o600, info.st_nlink == 1,
                  unlink(path) == 0 else { throw CompanionFailure.unsafeStorage }
            removedOrphan = true
        }
        if removedOrphan { try syncRuntimeDirectory() }
    }

    private func recoverAsFailedLocked(_ current: BridgeRecording) {
        failLocked(current, reason: "companion-restart")
    }

    private func validateResultFile(
        _ url: URL, length: Int, maximumResultBytes: Int64, sha256: String
    ) throws -> Bool {
        var info = stat()
        guard lstat(url.path, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), (info.st_mode & 0o777) == 0o600,
              info.st_nlink == 1, info.st_size == length,
              (try? validateFinalizedWav(url, maximumResultBytes: maximumResultBytes)) == length else { return false }
        return try fileDigest(url) == sha256
    }
}

private func littleEndianUInt16(_ data: Data, _ offset: Int) -> UInt16 {
    UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
}

private func littleEndianUInt32(_ data: Data, _ offset: Int) -> UInt32 {
    UInt32(data[offset]) | UInt32(data[offset + 1]) << 8 |
        UInt32(data[offset + 2]) << 16 | UInt32(data[offset + 3]) << 24
}

private func validateFinalizedWav(_ url: URL, maximumResultBytes: Int64) throws -> Int {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CompanionFailure.failed }
    defer { Darwin.close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(), (info.st_mode & 0o777) == 0o600,
          info.st_nlink == 1, info.st_size >= 44,
          info.st_size <= maximumResultBytes,
          info.st_size <= maximumRetainedWavBytes,
          info.st_size <= off_t(Int.max) else { throw CompanionFailure.failed }
    func readAt(_ offset: Int, _ count: Int) throws -> Data {
        var data = Data(count: count)
        let amount = data.withUnsafeMutableBytes { bytes in
            pread(descriptor, bytes.baseAddress!, count, off_t(offset))
        }
        guard amount == count else { throw CompanionFailure.failed }
        return data
    }
    let riff = try readAt(0, 12)
    let fileSize = Int(info.st_size)
    guard String(data: riff[0..<4], encoding: .ascii) == "RIFF",
          String(data: riff[8..<12], encoding: .ascii) == "WAVE",
          Int(littleEndianUInt32(riff, 4)) + 8 == fileSize else { throw CompanionFailure.failed }
    var offset = 12
    var formatSeen = false
    var dataSeen = false
    var pcmBytes = 0
    while offset + 8 <= fileSize {
        guard offset + 8 <= maximumWavHeaderBytes else { throw CompanionFailure.failed }
        let chunk = try readAt(offset, 8)
        let identifier = String(data: chunk[0..<4], encoding: .ascii)
        let size = Int(littleEndianUInt32(chunk, 4))
        let body = offset + 8
        let (unpaddedEnd, overflow) = body.addingReportingOverflow(size)
        let end = unpaddedEnd + (size % 2)
        guard !overflow, end > offset, end <= fileSize else { throw CompanionFailure.failed }
        if identifier == "fmt " {
            guard !formatSeen, !dataSeen, size >= 16 else { throw CompanionFailure.failed }
            let format = try readAt(body, 16)
            guard littleEndianUInt16(format, 0) == 1,
                  littleEndianUInt16(format, 2) == 1,
                  littleEndianUInt32(format, 4) == 16_000,
                  littleEndianUInt32(format, 8) == 32_000,
                  littleEndianUInt16(format, 12) == 2,
                  littleEndianUInt16(format, 14) == 16 else { throw CompanionFailure.failed }
            formatSeen = true
        } else if identifier == "data" {
            let maximumPcmBytes = maximumResultBytes - Int64(maximumWavHeaderBytes)
            guard formatSeen, !dataSeen, size >= 2, size % 2 == 0,
                  body <= maximumWavHeaderBytes, maximumPcmBytes >= 2,
                  Int64(size) <= maximumPcmBytes else { throw CompanionFailure.failed }
            dataSeen = true
            pcmBytes = size
        }
        offset = end
    }
    guard offset == fileSize, formatSeen, dataSeen,
          fileSize - pcmBytes <= maximumWavHeaderBytes else { throw CompanionFailure.failed }
    return fileSize
}

private func syncResultFile(_ url: URL) throws {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw CompanionFailure.unsafeStorage }
    defer { Darwin.close(descriptor) }
    guard fsync(descriptor) == 0 else { throw CompanionFailure.unsafeStorage }
}

private func fileDigest(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var digest = SHA256()
    while true {
        let chunk = try handle.read(upToCount: streamingBufferBytes) ?? Data()
        if chunk.isEmpty { break }
        recordResourceMetric("sha256", bytes: chunk.count)
        digest.update(data: chunk)
    }
    return Data(digest.finalize()).hex
}

private func readAuthenticatedRequest(_ descriptor: Int32, credentials: [String: Credential]) throws -> AuthenticatedRequest {
    let challenge = try randomChallenge()
    try writeFrame(descriptor, object: [
        "type": "challenge", "challenge": challenge.base64EncodedString()
    ])
    let request = try readFrame(descriptor)
    try requireStreamEnd(descriptor)
    let required: Set<String> = ["type", "version", "credentialId", "requestId", "operation", "payload", "hmac"]
    guard exactKeys(request, required),
          request["type"] as? String == "request",
          let clientVersion = jsonInteger(request["version"]), clientVersion > 0,
          let credentialId = request["credentialId"] as? String,
          canonicalUUID(credentialId),
          let requestId = request["requestId"] as? String,
          canonicalUUID(requestId),
          let operation = request["operation"] as? String,
          let payloadText = request["payload"] as? String,
          let payloadData = canonicalBase64(payloadText),
          let payload = try? strictJSONObject(payloadData),
          let tagText = request["hmac"] as? String,
          let tag = Data(hex: tagText) else { throw CompanionFailure.authentication }
    let credential = credentials[credentialId] ?? Credential(id: credentialId, secret: unknownCredentialSecret)
    guard let secret = canonicalBase64(credential.secret, bytes: 32) else { throw CompanionFailure.authentication }
    let expected = authenticationTag(secret: secret, fields: [
        utf8("request"), utf8(String(clientVersion)), challenge, utf8(credential.id),
        utf8(requestId), utf8(operation), payloadData
    ])
    guard constantTimeEqual(tag, expected), credentials[credentialId] != nil else {
        throw CompanionFailure.authentication
    }
    return AuthenticatedRequest(
        credential: credential, clientVersion: clientVersion, secret: secret, challenge: challenge,
        requestId: requestId, operation: operation, payloadData: payloadData, payload: payload
    )
}

private func writeAuthenticatedResponse(
    _ descriptor: Int32,
    request: AuthenticatedRequest,
    status: String = "ok",
    payloadObject: [String: Any]
) throws {
    let payload = try jsonData(payloadObject)
    let responseTag = authenticationTag(secret: request.secret, fields: [
        utf8("response"), utf8(String(request.clientVersion)), utf8(String(protocolVersion)),
        request.challenge, utf8(request.credential.id),
        utf8(request.requestId), utf8(request.operation + ":" + status), payload
    ])
    try writeFrame(descriptor, object: [
        "type": "response", "version": protocolVersion, "requestId": request.requestId,
        "status": status, "payload": payload.base64EncodedString(), "hmac": responseTag.hex
    ])
}

private func requestLease(_ payload: [String: Any]) throws -> (id: String, leaseSecret: Data) {
    guard let id = payload["recordingId"] as? String, canonicalUUID(id),
          let leaseText = payload["leaseSecret"] as? String,
          let leaseSecret = canonicalBase64(leaseText, bytes: 32) else {
        throw CompanionFailure.invalidFrame
    }
    return (id, leaseSecret)
}

private func setSendTimeout(_ descriptor: Int32, seconds: Int) throws {
    var timeout = timeval(tv_sec: seconds, tv_usec: 0)
    var sendBuffer = fixedSocketSendBufferBytes
    guard setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                     socklen_t(MemoryLayout<timeval>.size)) == 0,
          setsockopt(descriptor, SOL_SOCKET, SO_SNDBUF, &sendBuffer,
                     socklen_t(MemoryLayout<Int32>.size)) == 0 else {
        throw CompanionFailure.invalidSocket
    }
}

private func streamFile(_ descriptor: Int32, url: URL) throws {
#if PROTOCOL_TESTING
    if let delayText = ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_FETCH_DELAY_MS"],
       let delay = UInt32(delayText), delay > 0 { usleep(delay * 1_000) }
#endif
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    while true {
        let chunk = try handle.read(upToCount: streamingBufferBytes) ?? Data()
        if chunk.isEmpty { break }
        recordResourceMetric("fetch", bytes: chunk.count)
        try writeAll(descriptor, data: chunk)
    }
}

private func handleRequest(
    _ descriptor: Int32,
    credentials: [String: Credential],
    recordings: RecordingManager,
    authenticationCompleted: () -> Void
) throws {
    let request = try readAuthenticatedRequest(descriptor, credentials: credentials)
    authenticationCompleted()
    try recordings.openConnection(ownerId: request.credential.id, descriptor: descriptor)
    var fetchRecordingId: String?
    defer {
        if let fetchRecordingId { recordings.endFetch(id: fetchRecordingId, descriptor: descriptor) }
        recordings.closeConnection(ownerId: request.credential.id, descriptor: descriptor)
    }
    let replay: (String, [String: Any])?
    do {
        replay = try recordings.register(ownerId: request.credential.id, requestId: request.requestId,
                                         clientVersion: request.clientVersion, operation: request.operation,
                                         payload: request.payloadData)
    } catch CompanionFailure.requestConflict {
        try writeAuthenticatedResponse(descriptor, request: request, status: "request-conflict", payloadObject: [:])
        return
    } catch CompanionFailure.notFound {
        try writeAuthenticatedResponse(descriptor, request: request, status: "not-found", payloadObject: [:])
        return
    } catch {
        try writeAuthenticatedResponse(descriptor, request: request, status: "failed", payloadObject: [:])
        return
    }
    recordings.delayAfterRegistrationForTesting(operation: request.operation)
    if let replay {
        var replayURL: URL?
        if request.operation == "fetch", replay.0 == "ok" {
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            replayURL = try recordings.beginFetch(
                id: owned.id, ownerId: request.credential.id,
                leaseSecret: owned.leaseSecret, descriptor: descriptor
            ).url
            fetchRecordingId = owned.id
            try setSendTimeout(descriptor, seconds: 10)
        }
        try writeAuthenticatedResponse(descriptor, request: request, status: replay.0, payloadObject: replay.1)
        if let replayURL { try streamFile(descriptor, url: replayURL) }
        return
    }
    if request.clientVersion != protocolVersion {
        let payload: [String: Any] = [
            "clientVersion": request.clientVersion, "companionVersion": protocolVersion,
        ]
        try recordings.recordResponse(ownerId: request.credential.id, requestId: request.requestId,
                                      status: "version-mismatch", payload: payload)
        try writeAuthenticatedResponse(descriptor, request: request, status: "version-mismatch", payloadObject: payload)
        return
    }
    if !validRequestOperations.contains(request.operation) {
        try recordings.recordResponse(ownerId: request.credential.id, requestId: request.requestId,
                                      status: "failed", payload: [:])
        try writeAuthenticatedResponse(descriptor, request: request, status: "failed", payloadObject: [:])
        return
    }

    var status = "ok"
    var payload: [String: Any] = [:]
    var streamURL: URL?
    var levelSubscriber: LevelSubscriber?
    do {
        switch request.operation {
        case "health":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            payload = [
                "permission": permissionName(AVCaptureDevice.authorizationStatus(for: .audio)),
                "defaultInputAvailable": AVCaptureDevice.default(for: .audio) != nil,
            ]
        case "credential-effects":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            payload = recordings.credentialEffects(ownerId: request.credential.id, currentDescriptor: descriptor)
        case "credential-cancel-recordings", "credential-quiesce-if-idle":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            payload = try recordings.quiesceCredentialForUpgrade(
                ownerId: request.credential.id, currentDescriptor: descriptor,
                cancelRecordings: request.operation == "credential-cancel-recordings"
            )
        case "credential-revoke", "credential-revoke-if-idle", "credential-revoke-if-no-active":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            payload = try recordings.revokeCredential(
                ownerId: request.credential.id, requestId: request.requestId,
                clientVersion: request.clientVersion, operation: request.operation,
                payload: request.payloadData, currentDescriptor: descriptor,
                onlyIfIdle: request.operation == "credential-revoke-if-idle",
                onlyIfNoActive: request.operation == "credential-revoke-if-no-active"
            )
        case "start":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "maxDurationMs"]),
                  let id = request.payload["recordingId"] as? String, canonicalUUID(id),
                  let leaseText = request.payload["leaseSecret"] as? String,
                  let leaseSecret = canonicalBase64(leaseText, bytes: 32),
                  let maximumDurationMs = jsonInteger(request.payload["maxDurationMs"]) else { throw CompanionFailure.invalidFrame }
            payload = try recordings.start(id: id, ownerId: request.credential.id,
                                           leaseSecret: leaseSecret, maximumDurationMs: maximumDurationMs)
        case "levels":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "afterSequence"]),
                  let after = jsonInteger(request.payload["afterSequence"]), after >= -1 else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            let values = try recordings.levels(id: owned.id, ownerId: request.credential.id,
                                                leaseSecret: owned.leaseSecret, after: after)
            payload = ["observations": values]
        case "subscribe-levels":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "afterSequence"]),
                  let after = jsonInteger(request.payload["afterSequence"]), after >= -1 else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            let subscriber = LevelSubscriber(descriptor: descriptor, request: request)
            payload = try recordings.subscribe(
                id: owned.id, ownerId: request.credential.id,
                leaseSecret: owned.leaseSecret, after: after, subscriber: subscriber
            )
            levelSubscriber = subscriber
        case "status":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            payload = try recordings.status(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret)
        case "stop":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            payload = try recordings.stop(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret)
        case "fetch":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            let result = try recordings.beginFetch(
                id: owned.id, ownerId: request.credential.id,
                leaseSecret: owned.leaseSecret, descriptor: descriptor
            )
            fetchRecordingId = owned.id
            payload = result.payload
            streamURL = result.url
        case "cancel":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            payload = try recordings.cancel(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret)
        case "acknowledge":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            payload = try recordings.acknowledge(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret)
        default:
            throw CompanionFailure.invalidFrame
        }
    } catch CompanionFailure.busy {
        status = "busy"
    } catch CompanionFailure.notFound {
        status = "not-found"
    } catch CompanionFailure.invalidState {
        status = "invalid-state"
    } catch CompanionFailure.storageFull {
        status = "failed"
        payload = ["reason": "storage-full"]
    } catch {
        status = "failed"
    }
    try recordings.recordResponse(ownerId: request.credential.id, requestId: request.requestId,
                                  status: status, payload: payload)
    if streamURL != nil { try setSendTimeout(descriptor, seconds: 10) }
    try writeAuthenticatedResponse(descriptor, request: request, status: status, payloadObject: payload)
    if let streamURL { try streamFile(descriptor, url: streamURL) }
    if status == "ok", let levelSubscriber {
        levelSubscriber.start()
        levelSubscriber.wait()
    }
}

private func removeStaleSocketIfSafe(path: String) throws {
    var info = stat()
    guard lstat(path, &info) == 0 else {
        if errno == ENOENT { return }
        throw CompanionFailure.invalidSocket
    }
    guard (info.st_mode & S_IFMT) == S_IFSOCK,
          info.st_uid == getuid(),
          (info.st_mode & 0o777) == 0o600 else { throw CompanionFailure.invalidSocket }

    let probe = socket(AF_UNIX, SOCK_STREAM, 0)
    guard probe >= 0 else { throw CompanionFailure.invalidSocket }
    defer { Darwin.close(probe) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw CompanionFailure.invalidSocket
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
            for index in pathBytes.indices { destination[index] = pathBytes[index] }
        }
    }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if result == 0 { throw CompanionFailure.invalidSocket }
    guard errno == ECONNREFUSED, unlink(path) == 0 else { throw CompanionFailure.invalidSocket }
}

private func makeUnixListener(path: String) throws -> Int32 {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw CompanionFailure.invalidSocket }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        Darwin.close(descriptor)
        throw CompanionFailure.invalidSocket
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
            for index in pathBytes.indices { destination[index] = pathBytes[index] }
        }
    }
    let bindResult = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard bindResult == 0 else {
        Darwin.close(descriptor)
        throw CompanionFailure.invalidSocket
    }
    guard chmod(path, S_IRUSR | S_IWUSR) == 0, listen(descriptor, 64) == 0 else {
        Darwin.close(descriptor)
        unlink(path)
        throw CompanionFailure.invalidSocket
    }
    return descriptor
}

func ownerVisibleLifecycleReason(systemEvent: String) -> String? {
    switch systemEvent {
    case "logout": return "logout"
    case "restart", "shutdown": return "reboot"
    default: return nil
    }
}

private final class LifecycleAppleEventRouter: NSObject {
    let onLogout: () -> Void
    let onReboot: () -> Void

    init(onLogout: @escaping () -> Void, onReboot: @escaping () -> Void) {
        self.onLogout = onLogout
        self.onReboot = onReboot
    }

    @objc func logout(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) { onLogout() }
    @objc func reboot(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) { onReboot() }
}

private final class BoundedLog {
    private let path: String
    private let lock = NSLock()
    private var previous = ""
    private var repeats = 0
    private var closed = false
    private let maximumBytes: off_t

    init(runtime: String) {
        path = runtime + "/companion.log"
#if PROTOCOL_TESTING
        maximumBytes = off_t(Int(ProcessInfo.processInfo.environment["PI_DICTATION_PROTOCOL_TEST_LOG_BYTES"] ?? "") ?? 1024 * 1024)
#else
        maximumBytes = 1024 * 1024
#endif
    }

    func event(_ code: String) {
        let safeCode = code.range(of: "^[a-z0-9-]{1,64}$", options: .regularExpression) == nil ? "unknown" : code
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        if safeCode == previous {
            repeats = min(1_000_000, repeats + 1)
            return
        }
        flushRepeatsLocked()
        appendLocked("{\"component\":\"companion\",\"code\":\"\(safeCode)\"}\n")
        previous = safeCode
    }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        flushRepeatsLocked()
        closed = true
        lock.unlock()
    }

    private func flushRepeatsLocked() {
        guard repeats > 0 else { return }
        appendLocked("{\"component\":\"companion\",\"code\":\"repeated\",\"count\":\(repeats)}\n")
        repeats = 0
    }

    private func safeFileSize(_ candidate: String) -> off_t? {
        var info = stat()
        if lstat(candidate, &info) != 0 { return errno == ENOENT ? 0 : nil }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
              (info.st_mode & 0o777) == 0o600, info.st_nlink == 1 else { return nil }
        return info.st_size
    }

    private func appendLocked(_ line: String) {
        let data = Data(line.utf8)
        guard data.count <= 1024, let size = safeFileSize(path) else { return }
        if size + off_t(data.count) > maximumBytes {
            guard safeFileSize(path + ".1") != nil, safeFileSize(path + ".2") != nil else { return }
            unlink(path + ".2")
            if rename(path + ".1", path + ".2") != 0, errno != ENOENT { return }
            guard rename(path, path + ".1") == 0 else { return }
        }
        let descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { return }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1,
              info.st_size + off_t(data.count) <= maximumBytes else { return }
        try? writeAll(descriptor, data: data)
    }
}

private final class ConnectionLimiter {
    private let lock = NSLock()
    private var active = 0

    func acquire() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard active < maximumConnections else { return false }
        active += 1
        return true
    }

    func release() {
        lock.lock()
        active = max(0, active - 1)
        lock.unlock()
    }
}

private func serve() throws {
    let paths = fixedPaths()
    try verifyDirectory(paths.root)
    try verifyDirectory(paths.runtime)
    try verifyPreflightReceipt(root: paths.root)
    let recordings = try RecordingManager(runtime: paths.runtime, upgradeStatePath: paths.root + "/upgrade.json")
    let connectionLimiter = ConnectionLimiter()
    let logger = BoundedLog(runtime: paths.runtime)
    logger.event("companion-start")
    try removeStaleSocketIfSafe(path: paths.socket)
    let listener = try makeUnixListener(path: paths.socket)
    func signalSource(_ value: Int32, reason: String, exits: Bool) -> DispatchSourceSignal {
        signal(value, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
        source.setEventHandler {
            recordings.failActive(reason: reason)
            if exits {
                logger.event("companion-stop")
                logger.close()
                Darwin.close(listener)
                unlink(paths.socket)
                exit(EXIT_SUCCESS)
            }
        }
        source.resume()
        return source
    }
    signal(SIGUSR1, SIG_IGN)
    let durationRequest = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .global())
    durationRequest.setEventHandler { recordings.enforceDurationLimit() }
    durationRequest.resume()
    var lifecycleSignals = [
        signalSource(SIGTERM, reason: "companion-stop", exits: true),
        signalSource(SIGINT, reason: "companion-stop", exits: true),
        signalSource(SIGHUP, reason: "logout", exits: true),
        signalSource(SIGQUIT, reason: "reboot", exits: true),
    ]
#if PROTOCOL_TESTING
    lifecycleSignals.append(signalSource(SIGTSTP, reason: "sleep", exits: false))
    lifecycleSignals.append(signalSource(SIGUSR2, reason: "session-lock", exits: false))
    lifecycleSignals.append(signalSource(SIGWINCH, reason: "device-loss", exits: false))
#endif
    let appleEvents = NSAppleEventManager.shared()
    let lifecycleRouter = LifecycleAppleEventRouter(
        onLogout: { recordings.failActive(reason: ownerVisibleLifecycleReason(systemEvent: "logout")!) },
        onReboot: { recordings.failActive(reason: ownerVisibleLifecycleReason(systemEvent: "restart")!) }
    )
    let coreEventClass = AEEventClass(0x61657674)
    let logoutEvent = AEEventID(0x6c6f676f)
    let restartEvent = AEEventID(0x72657374)
    let shutdownEvent = AEEventID(0x73687574)
    appleEvents.setEventHandler(lifecycleRouter, andSelector: #selector(LifecycleAppleEventRouter.logout(_:reply:)),
                                forEventClass: coreEventClass, andEventID: logoutEvent)
    appleEvents.setEventHandler(lifecycleRouter, andSelector: #selector(LifecycleAppleEventRouter.reboot(_:reply:)),
                                forEventClass: coreEventClass, andEventID: restartEvent)
    appleEvents.setEventHandler(lifecycleRouter, andSelector: #selector(LifecycleAppleEventRouter.reboot(_:reply:)),
                                forEventClass: coreEventClass, andEventID: shutdownEvent)
    let workspace = NSWorkspace.shared.notificationCenter
    let sleepObserver = workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in
        recordings.failActive(reason: "sleep")
    }
    let lockObserver = workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: nil) { _ in
        recordings.failActive(reason: "session-lock")
    }
    defer {
        logger.event("companion-stop")
        logger.close()
        durationRequest.cancel()
        for source in lifecycleSignals { source.cancel() }
        workspace.removeObserver(sleepObserver)
        workspace.removeObserver(lockObserver)
        appleEvents.removeEventHandler(forEventClass: coreEventClass, andEventID: logoutEvent)
        appleEvents.removeEventHandler(forEventClass: coreEventClass, andEventID: restartEvent)
        appleEvents.removeEventHandler(forEventClass: coreEventClass, andEventID: shutdownEvent)
        Darwin.close(listener)
        unlink(paths.socket)
    }
    DispatchQueue.global().async {
        while true {
            var timeout = timeval(tv_sec: 5, tv_usec: 0)
            var sendBuffer = fixedSocketSendBufferBytes
            var noSignal: Int32 = 1
            let client = accept(listener, nil, nil)
            if client < 0 { continue }
            guard connectionLimiter.acquire() else {
                shutdown(client, SHUT_RDWR)
                Darwin.close(client)
                continue
            }
            guard setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                             socklen_t(MemoryLayout<Int32>.size)) == 0,
                  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                             socklen_t(MemoryLayout<timeval>.size)) == 0,
                  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                             socklen_t(MemoryLayout<timeval>.size)) == 0,
                  setsockopt(client, SOL_SOCKET, SO_SNDBUF, &sendBuffer,
                             socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                connectionLimiter.release()
                shutdown(client, SHUT_RDWR)
                Darwin.close(client)
                continue
            }
            let authenticationDeadline = DispatchWorkItem { shutdown(client, SHUT_RDWR) }
            DispatchQueue.global().asyncAfter(
                deadline: .now() + authenticationDeadlineSeconds,
                execute: authenticationDeadline
            )
            DispatchQueue.global().async {
                defer {
                    authenticationDeadline.cancel()
                    connectionLimiter.release()
                }
                do {
                    let credentials = try readCredentials(primary: paths.credential, hosts: paths.hostCredentials)
                    try handleRequest(
                        client, credentials: credentials, recordings: recordings,
                        authenticationCompleted: { authenticationDeadline.cancel() }
                    )
                }
                catch {
                    logger.event("request-failed")
                }
                shutdown(client, SHUT_RDWR)
                Darwin.close(client)
            }
        }
    }
    RunLoop.current.run()
}

private extension Data {
    init?(hex: String) {
        guard hex.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
        var result = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        self = result
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

#if !PI_DICTATION_TESTING
@main
private struct CompanionMain {
    static func main() {
        umask(0o077)
        var arguments = Array(CommandLine.arguments.dropFirst())
        if let preflightIndex = arguments.firstIndex(of: "--preflight-result") {
            if preflightIndex + 1 >= arguments.count { exit(EXIT_FAILURE) }
            let resultPath = arguments[preflightIndex + 1]
            arguments.removeSubrange(preflightIndex...(preflightIndex + 1))
            if !arguments.allSatisfy({ $0.hasPrefix("-psn_") }) { exit(EXIT_FAILURE) }
            do {
                try writePreflightResult(to: resultPath)
                exit(EXIT_SUCCESS)
            } catch {
                exit(EXIT_FAILURE)
            }
        }
        if !arguments.allSatisfy({ $0.hasPrefix("-psn_") }) { exit(EXIT_FAILURE) }
        do {
            try serve()
        } catch {
            exit(EXIT_FAILURE)
        }
    }
}
#endif
