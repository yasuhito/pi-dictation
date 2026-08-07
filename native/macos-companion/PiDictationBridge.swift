import Foundation
import AVFoundation
import CryptoKit
import Security
import Darwin
import CoreMedia
import AudioToolbox

private let productIdentifier = "com.yasuhito.pi-dictation.bridge"
private let protocolVersion = 3
private let maximumFrameBytes = 64 * 1024
private let challengeBytes = 32
private let resultRetentionSeconds: TimeInterval = 5 * 60

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
    let home = NSHomeDirectory()
    let root = home + "/Library/Application Support/pi-dictation/bridge"
    let runtime = home + "/Library/Caches/pi-dictation/bridge"
    return (root, runtime, runtime + "/companion.sock", root + "/credential.json", root + "/hosts")
}

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
        let credentialPath = directory + "/credential.json"
        var credentialInfo = stat()
        if lstat(credentialPath, &credentialInfo) != 0 {
            guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
            continue
        }
        let credential = try readCredential(credentialPath)
        guard credentials[credential.id] == nil else { throw CompanionFailure.invalidCredential }
        credentials[credential.id] = credential
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
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
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

private final class BridgeRecording {
    let id: String
    let ownerId: String
    let leaseHash: Data
    let url: URL
    let recorder: AVAudioRecorder?
    var state = "recording"
    var length: Int?
    var sha256: String?
    var completion = "stopped"
    var observations: [[String: Any]] = []
    var sequence = 0
    var levelTimer: DispatchSourceTimer?
    var durationTimer: DispatchWorkItem?
    var retentionTimer: DispatchWorkItem?

    init(id: String, ownerId: String, leaseHash: Data, url: URL, recorder: AVAudioRecorder?) {
        self.id = id
        self.ownerId = ownerId
        self.leaseHash = leaseHash
        self.url = url
        self.recorder = recorder
    }
}

private final class RecordingManager {
    private let runtime: String
    private let lock = NSLock()
    private var recordings: [String: BridgeRecording] = [:]
    private var activeId: String?
    private var requests: [String: Data] = [:]
    private var busyStartRequests: Set<String> = []

    init(runtime: String) { self.runtime = runtime }

    func register(ownerId: String, requestId: String, operation: String, payload: Data) throws {
        var digest = SHA256()
        digest.update(data: Data(operation.utf8))
        digest.update(data: Data([0]))
        digest.update(data: payload)
        let content = Data(digest.finalize())
        let key = ownerId + ":" + requestId
        lock.lock()
        defer { lock.unlock() }
        if let previous = requests[key] {
            guard constantTimeEqual(previous, content) else { throw CompanionFailure.requestConflict }
            return
        }
        requests[key] = content
    }

    func start(id: String, ownerId: String, requestId: String, leaseSecret: Data, maximumDurationMs: Int) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let requestKey = ownerId + ":" + requestId
        if busyStartRequests.contains(requestKey) { throw CompanionFailure.busy }
        let leaseHash = Data(SHA256.hash(data: leaseSecret))
        if let existing = recordings[id],
           existing.ownerId == ownerId,
           constantTimeEqual(existing.leaseHash, leaseHash) {
            return statusPayload(existing)
        }
        guard activeId == nil else {
            busyStartRequests.insert(requestKey)
            throw CompanionFailure.busy
        }
        guard recordings[id] == nil else { throw CompanionFailure.notFound }
        guard maximumDurationMs >= 1000,
              maximumDurationMs <= 60 * 60 * 1000 else { throw CompanionFailure.failed }
#if !PROTOCOL_TESTING
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
              AVCaptureDevice.default(for: .audio) != nil else { throw CompanionFailure.failed }
#endif
        let maximumBytes = Int64(maximumDurationMs) * 32 + Int64(maximumFrameBytes)
        let capacity = try URL(fileURLWithPath: runtime).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard capacity >= maximumBytes else { throw CompanionFailure.failed }
        let url = URL(fileURLWithPath: runtime + "/recording-" + id + ".wav")
        var existing = stat()
        guard lstat(url.path, &existing) != 0, errno == ENOENT else { throw CompanionFailure.unsafeStorage }
        let audioRecorder: AVAudioRecorder?
#if PROTOCOL_TESTING
        guard FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: 46)),
              chmod(url.path, S_IRUSR | S_IWUSR) == 0 else { throw CompanionFailure.failed }
        audioRecorder = nil
#else
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000.0,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        let createdRecorder = try AVAudioRecorder(url: url, settings: settings)
        createdRecorder.isMeteringEnabled = true
        guard createdRecorder.prepareToRecord(), chmod(url.path, S_IRUSR | S_IWUSR) == 0,
              createdRecorder.record() else {
            try? FileManager.default.removeItem(at: url)
            throw CompanionFailure.failed
        }
        audioRecorder = createdRecorder
#endif
        let current = BridgeRecording(id: id, ownerId: ownerId, leaseHash: leaseHash, url: url, recorder: audioRecorder)
        recordings[id] = current
        activeId = id
        let levels = DispatchSource.makeTimerSource(queue: .global())
        levels.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
        levels.setEventHandler { [weak self, weak current] in
            guard let self, let current else { return }
            self.captureLevel(current)
        }
        current.levelTimer = levels
        levels.resume()
        let expiry = DispatchWorkItem { [weak self, weak current] in
            guard let self, let current else { return }
            self.finalize(current, completion: "duration-limit")
        }
        current.durationTimer = expiry
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(maximumDurationMs), execute: expiry)
        return statusPayload(current)
    }

    private func captureLevel(_ current: BridgeRecording) {
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "recording", activeId == current.id else { return }
        current.recorder?.updateMeters()
        let power = current.recorder?.averagePower(forChannel: 0) ?? -160
        current.observations.append(["sequence": current.sequence, "capturedAtMs": current.sequence * 50,
                                     "dbfs": power <= -160 ? "silence" : Double(power)])
        current.sequence += 1
        if current.observations.count > 500 { current.observations.removeFirst(current.observations.count - 500) }
    }

    func levels(id: String, ownerId: String, leaseSecret: Data, after: Int) throws -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        guard current.state == "recording" else { throw CompanionFailure.invalidState }
        return current.observations.filter { ($0["sequence"] as? Int ?? -1) > after }
    }

    func status(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return statusPayload(try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret))
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
        beginFinalizationLocked(current, completion: "stopped")
        lock.unlock()
        completeFinalization(current)
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "result-ready" || current.state == "finalizing" else { throw CompanionFailure.invalidState }
        return statusPayload(current)
    }

    func fetch(id: String, ownerId: String, leaseSecret: Data) throws -> (payload: [String: Any], url: URL) {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        guard current.state == "result-ready" else { throw CompanionFailure.invalidState }
        return (statusPayload(current).filter { $0.key != "state" }, current.url)
    }

    func cancel(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        if current.state == "cancelled" { return statusPayload(current) }
        guard ["recording", "finalizing", "result-ready"].contains(current.state) else { throw CompanionFailure.invalidState }
        current.durationTimer?.cancel(); current.retentionTimer?.cancel(); current.levelTimer?.cancel()
        current.recorder?.stop()
        if FileManager.default.fileExists(atPath: current.url.path) {
            try FileManager.default.removeItem(at: current.url)
        }
        if activeId == current.id { activeId = nil }
        current.state = "cancelled"; current.length = nil; current.sha256 = nil
        return statusPayload(current)
    }

    func acknowledge(id: String, ownerId: String, leaseSecret: Data) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let current = try owned(id: id, ownerId: ownerId, leaseSecret: leaseSecret)
        if current.state == "acknowledged" { return statusPayload(current) }
        guard current.state == "result-ready" else { throw CompanionFailure.invalidState }
        try FileManager.default.removeItem(at: current.url)
        current.retentionTimer?.cancel()
        current.state = "acknowledged"; current.length = nil; current.sha256 = nil
        return statusPayload(current)
    }

    private func owned(id: String, ownerId: String, leaseSecret: Data) throws -> BridgeRecording {
        let supplied = Data(SHA256.hash(data: leaseSecret))
        let expected = recordings[id]?.leaseHash ?? Data(repeating: 0, count: 32)
        let matches = constantTimeEqual(expected, supplied)
        guard let current = recordings[id], current.ownerId == ownerId, matches else { throw CompanionFailure.notFound }
        return current
    }

    private func statusPayload(_ current: BridgeRecording) -> [String: Any] {
        var payload: [String: Any] = ["recordingId": current.id, "state": current.state]
        if current.state == "result-ready", let length = current.length, let sha256 = current.sha256 {
            payload["length"] = length; payload["sha256"] = sha256; payload["completion"] = current.completion
        }
        return payload
    }

    private func finalize(_ current: BridgeRecording, completion: String) {
        lock.lock()
        guard current.state == "recording" else { lock.unlock(); return }
        beginFinalizationLocked(current, completion: completion)
        lock.unlock()
        completeFinalization(current)
    }

    private func beginFinalizationLocked(_ current: BridgeRecording, completion: String) {
        current.completion = completion
        current.state = "finalizing"
        current.durationTimer?.cancel(); current.levelTimer?.cancel(); current.recorder?.stop()
    }

    private func completeFinalization(_ current: BridgeRecording) {
        var result: (Int, String)?
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: current.url.path)
            guard let size = attributes[.size] as? NSNumber, size.intValue >= 44 else { throw CompanionFailure.failed }
            result = (size.intValue, try fileDigest(current.url))
        } catch {}
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "finalizing" else { return }
        if let result {
            current.length = result.0; current.sha256 = result.1; current.state = "result-ready"
        } else {
            try? FileManager.default.removeItem(at: current.url)
            current.state = "failed"; current.length = nil; current.sha256 = nil
        }
        if activeId == current.id { activeId = nil }
        let retention = DispatchWorkItem { [weak self, weak current] in
            guard let self, let current else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard current.state == "result-ready" else { return }
            try? FileManager.default.removeItem(at: current.url)
            current.state = "expired"; current.length = nil; current.sha256 = nil
        }
        current.retentionTimer = retention
        DispatchQueue.global().asyncAfter(deadline: .now() + resultRetentionSeconds, execute: retention)
    }
}

private func fileDigest(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var digest = SHA256()
    while true {
        let chunk = try handle.read(upToCount: 64 * 1024) ?? Data()
        if chunk.isEmpty { break }
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
          let credential = credentials[credentialId],
          let secret = canonicalBase64(credential.secret, bytes: 32),
          let requestId = request["requestId"] as? String,
          canonicalUUID(requestId),
          let operation = request["operation"] as? String,
          let payloadText = request["payload"] as? String,
          let payloadData = canonicalBase64(payloadText),
          let payload = try? strictJSONObject(payloadData),
          let tagText = request["hmac"] as? String,
          let tag = Data(hex: tagText) else { throw CompanionFailure.authentication }
    let expected = authenticationTag(secret: secret, fields: [
        utf8("request"), utf8(String(clientVersion)), challenge, utf8(credential.id),
        utf8(requestId), utf8(operation), payloadData
    ])
    guard constantTimeEqual(tag, expected) else { throw CompanionFailure.authentication }
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

private func streamFile(_ descriptor: Int32, url: URL) throws {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    while true {
        let chunk = try handle.read(upToCount: 64 * 1024) ?? Data()
        if chunk.isEmpty { break }
        try writeAll(descriptor, data: chunk)
    }
}

private func handleRequest(
    _ descriptor: Int32,
    credentials: [String: Credential],
    recordings: RecordingManager
) throws {
    let request = try readAuthenticatedRequest(descriptor, credentials: credentials)
    guard request.clientVersion == protocolVersion else {
        try writeAuthenticatedResponse(descriptor, request: request, status: "version-mismatch", payloadObject: [
            "clientVersion": request.clientVersion, "companionVersion": protocolVersion,
        ])
        return
    }
    do {
        try recordings.register(ownerId: request.credential.id, requestId: request.requestId,
                                operation: request.operation, payload: request.payloadData)
        switch request.operation {
        case "health":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject: [
                "permission": permissionName(AVCaptureDevice.authorizationStatus(for: .audio)),
                "defaultInputAvailable": AVCaptureDevice.default(for: .audio) != nil,
            ])
        case "start":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "maxDurationMs"]),
                  let id = request.payload["recordingId"] as? String, canonicalUUID(id),
                  let leaseText = request.payload["leaseSecret"] as? String,
                  let leaseSecret = canonicalBase64(leaseText, bytes: 32),
                  let maximumDurationMs = jsonInteger(request.payload["maxDurationMs"]) else { throw CompanionFailure.invalidFrame }
            let payload = try recordings.start(id: id, ownerId: request.credential.id, requestId: request.requestId,
                                               leaseSecret: leaseSecret, maximumDurationMs: maximumDurationMs)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject: payload)
        case "levels":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "afterSequence"]),
                  let after = jsonInteger(request.payload["afterSequence"]), after >= -1 else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            let values = try recordings.levels(id: owned.id, ownerId: request.credential.id,
                                                leaseSecret: owned.leaseSecret, after: after)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject: ["observations": values])
        case "status":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject:
                try recordings.status(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret))
        case "stop":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject:
                try recordings.stop(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret))
        case "fetch":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            let result = try recordings.fetch(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject: result.payload)
            try streamFile(descriptor, url: result.url)
        case "cancel":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject:
                try recordings.cancel(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret))
        case "acknowledge":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject:
                try recordings.acknowledge(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret))
        default:
            throw CompanionFailure.invalidFrame
        }
    } catch CompanionFailure.busy {
        try writeAuthenticatedResponse(descriptor, request: request, status: "busy", payloadObject: [:])
    } catch CompanionFailure.notFound {
        try writeAuthenticatedResponse(descriptor, request: request, status: "not-found", payloadObject: [:])
    } catch CompanionFailure.requestConflict {
        try writeAuthenticatedResponse(descriptor, request: request, status: "request-conflict", payloadObject: [:])
    } catch CompanionFailure.invalidState {
        try writeAuthenticatedResponse(descriptor, request: request, status: "invalid-state", payloadObject: [:])
    } catch {
        try writeAuthenticatedResponse(descriptor, request: request, status: "failed", payloadObject: [:])
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
    guard chmod(path, S_IRUSR | S_IWUSR) == 0, listen(descriptor, 8) == 0 else {
        Darwin.close(descriptor)
        unlink(path)
        throw CompanionFailure.invalidSocket
    }
    return descriptor
}

private func serve() throws {
    let paths = fixedPaths()
    try verifyDirectory(paths.root)
    try verifyDirectory(paths.runtime)
    try verifyPreflightReceipt(root: paths.root)
    let credentials = try readCredentials(primary: paths.credential, hosts: paths.hostCredentials)
    let recordings = RecordingManager(runtime: paths.runtime)
    try removeStaleSocketIfSafe(path: paths.socket)
    let listener = try makeUnixListener(path: paths.socket)
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    let terminate = {
        Darwin.close(listener)
        unlink(paths.socket)
        exit(EXIT_SUCCESS)
    }
    termination.setEventHandler(handler: terminate)
    interruption.setEventHandler(handler: terminate)
    termination.resume()
    interruption.resume()
    defer {
        termination.cancel()
        interruption.cancel()
        Darwin.close(listener)
        unlink(paths.socket)
    }
    while true {
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        let client = accept(listener, nil, nil)
        if client < 0 { continue }
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        DispatchQueue.global().async {
            do { try handleRequest(client, credentials: credentials, recordings: recordings) } catch { }
            shutdown(client, SHUT_RDWR)
            Darwin.close(client)
        }
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count == 64, hex == hex.lowercased() else { return nil }
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
