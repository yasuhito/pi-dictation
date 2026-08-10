import Foundation
import AVFoundation
import CryptoKit
import Security
import Darwin
import CoreMedia
import AudioToolbox

private let productIdentifier = "com.yasuhito.pi-dictation.bridge"
private let protocolVersion = 2
private let maximumFrameBytes = 64 * 1024
private let challengeBytes = 32
private let resultRetentionSeconds: TimeInterval = 10 * 60
private let requestReceiptRetentionSeconds = resultRetentionSeconds
private let validRequestOperations: Set<String> = [
    "health", "start", "levels", "status", "stop", "fetch", "cancel", "acknowledge",
]
private let maximumObservationRequestReceipts = 256
private let maximumControlRequestReceipts = 4096
private let maximumRequestRegistryBytes = 32 * 1024 * 1024

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
    guard UUID(uuidString: credential.id) != nil,
          let secret = Data(base64Encoded: credential.secret),
          secret.count == 32 else { throw CompanionFailure.invalidCredential }
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

private func readFrame(_ descriptor: Int32) throws -> [String: Any] {
    let header = try readExactly(descriptor, count: 4)
    let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    guard length >= 2, length <= maximumFrameBytes else { throw CompanionFailure.invalidFrame }
    let payload = try readExactly(descriptor, count: Int(length))
    guard let value = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
        throw CompanionFailure.invalidFrame
    }
    return value
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

private struct AuthenticatedRequest {
    let credential: Credential
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
    var state: String
    var length: Int?
    var sha256: String?
    var completion: String?
    var terminalAt: TimeInterval?
}

private struct PersistedRequestReceipt: Codable {
    let ownerId: String
    let requestId: String
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
    var terminalAt: TimeInterval?
    var observations: [[String: Any]] = []
    var sequence = 0
    var levelTimer: DispatchSourceTimer?
    var durationTimer: DispatchWorkItem?
    var retentionTimer: DispatchWorkItem?

    init(id: String, ownerId: String, leaseHash: Data, url: URL, state: String = "recording",
         length: Int? = nil, sha256: String? = nil, completion: String = "stopped",
         terminalAt: TimeInterval? = nil, recorder: AVAudioRecorder? = nil) {
        self.id = id
        self.ownerId = ownerId
        self.leaseHash = leaseHash
        self.url = url
        self.state = state
        self.length = length
        self.sha256 = sha256
        self.completion = completion
        self.terminalAt = terminalAt
        self.recorder = recorder
    }
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
    private var recordings: [String: BridgeRecording] = [:]
    private var activeId: String?
    private var requests: [String: PersistedRequestReceipt] = [:]

    init(runtime: String) throws {
        self.runtime = runtime
        try restore()
    }

    func register(ownerId: String, requestId: String, operation: String, payload: Data) throws -> (String, [String: Any])? {
        var digest = SHA256()
        digest.update(data: Data(operation.utf8))
        digest.update(data: Data([0]))
        digest.update(data: payload)
        let contentHash = Data(digest.finalize()).hex
        let key = ownerId + ":" + requestId
        lock.lock()
        defer { lock.unlock() }
        pruneRequestReceiptsLocked()
        if let previous = requests[key] {
            guard previous.contentHash == contentHash else { throw CompanionFailure.requestConflict }
            let leaseOperations = ["levels", "status", "stop", "fetch", "cancel", "acknowledge"]
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
                guard let completed = requests[key], let status = completed.responseStatus,
                      let payload = completed.responsePayload,
                      let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    throw CompanionFailure.failed
                }
                return (status, object)
            }
        }
        let observationOperations = ["health", "levels", "status"]
        if !observationOperations.contains(operation) {
            let controlCount = requests.values.filter { !observationOperations.contains($0.operation) }.count
            guard controlCount < maximumControlRequestReceipts else { throw CompanionFailure.failed }
        }
        requests[key] = PersistedRequestReceipt(
            ownerId: ownerId, requestId: requestId, operation: operation, contentHash: contentHash,
            receivedAt: Date().timeIntervalSince1970, responseStatus: nil, responsePayload: nil
        )
        do { try persistRequestReceiptsLocked() }
        catch {
            requests.removeValue(forKey: key)
            throw error
        }
        return nil
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
        receipt.responseStatus = status
        receipt.responsePayload = try jsonData(payload)
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

    func start(id: String, ownerId: String, leaseSecret: Data, maximumDurationMs: Int) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let leaseHash = Data(SHA256.hash(data: leaseSecret))
        if let existing = recordings[id] {
            guard existing.ownerId == ownerId, constantTimeEqual(existing.leaseHash, leaseHash) else {
                throw CompanionFailure.notFound
            }
            return statusPayload(existing)
        }
        guard activeId == nil else { throw CompanionFailure.busy }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
              AVCaptureDevice.default(for: .audio) != nil,
              maximumDurationMs >= 1000,
              maximumDurationMs <= 60 * 60 * 1000 else { throw CompanionFailure.failed }
        let maximumBytes = Int64(maximumDurationMs) * 32 + Int64(maximumFrameBytes)
        let capacity = try URL(fileURLWithPath: runtime).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard capacity >= maximumBytes else { throw CompanionFailure.failed }
        let url = URL(fileURLWithPath: runtime + "/recording-" + id + ".wav")
        var existing = stat()
        guard lstat(url.path, &existing) != 0, errno == ENOENT else { throw CompanionFailure.unsafeStorage }

        let current = BridgeRecording(id: id, ownerId: ownerId, leaseHash: leaseHash, url: url)
        recordings[id] = current
        activeId = id
        do {
            try persistLocked(current)
        } catch {
            recordings.removeValue(forKey: id)
            activeId = nil
            throw error
        }
        try initializeCapture(
            attempt: {
                let settings: [String: Any] = [
                    AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000.0,
                    AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                ]
                let audioRecorder = try AVAudioRecorder(url: url, settings: settings)
                audioRecorder.isMeteringEnabled = true
                guard audioRecorder.prepareToRecord(), chmod(url.path, S_IRUSR | S_IWUSR) == 0, audioRecorder.record() else {
                    throw CompanionFailure.failed
                }
                current.recorder = audioRecorder
            },
            onFailure: { self.failLocked(current) }
        )

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
        guard current.state == "recording", activeId == current.id, let recorder = current.recorder else { return }
        recorder.updateMeters()
        let power = recorder.averagePower(forChannel: 0)
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
        if current.state == "cancelled" {
            do { try removeAudioLocked(current) }
            catch { scheduleCleanupRetryLocked(current); throw error }
            return statusPayload(current)
        }
        guard ["recording", "finalizing", "result-ready"].contains(current.state) else { throw CompanionFailure.invalidState }
        let terminalAt = Date().timeIntervalSince1970
        try persistTransitionLocked(current, state: "cancelled", terminalAt: terminalAt)
        current.durationTimer?.cancel(); current.retentionTimer?.cancel(); current.levelTimer?.cancel()
        current.recorder?.stop()
        current.recorder = nil
        if activeId == current.id { activeId = nil }
        current.state = "cancelled"; current.length = nil; current.sha256 = nil
        current.terminalAt = terminalAt
        do { try removeAudioLocked(current) }
        catch { scheduleCleanupRetryLocked(current); throw error }
        scheduleRetentionLocked(current)
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
        guard current.state == "result-ready" else { throw CompanionFailure.invalidState }
        let terminalAt = Date().timeIntervalSince1970
        try persistTransitionLocked(current, state: "acknowledged", terminalAt: terminalAt)
        current.retentionTimer?.cancel()
        current.state = "acknowledged"; current.length = nil; current.sha256 = nil
        current.terminalAt = terminalAt
        do { try removeAudioLocked(current) }
        catch { scheduleCleanupRetryLocked(current); throw error }
        scheduleRetentionLocked(current)
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
        current.state = "finalizing"
        current.durationTimer?.cancel(); current.levelTimer?.cancel(); current.recorder?.stop()
        current.recorder = nil
        try persistLocked(current)
    }

    private func completeFinalization(_ current: BridgeRecording) {
        var result: (Int, String)?
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: current.url.path)
            guard let size = attributes[.size] as? NSNumber, size.intValue >= 44 else { throw CompanionFailure.failed }
            try syncResultFile(current.url)
            result = (size.intValue, try fileDigest(current.url))
        } catch {}
        lock.lock()
        defer { lock.unlock() }
        guard current.state == "finalizing" else { return }
        if let result {
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

    private func failLocked(_ current: BridgeRecording) {
        current.durationTimer?.cancel(); current.levelTimer?.cancel(); current.recorder?.stop()
        current.recorder = nil
        current.state = "failed"; current.length = nil; current.sha256 = nil
        current.terminalAt = Date().timeIntervalSince1970
        if activeId == current.id { activeId = nil }
        let committed = commitFailedRecordingState(
            persist: { try self.persistLocked(current) },
            removeAudio: { try self.removeAudioLocked(current) },
            scheduleRetry: { self.scheduleCleanupRetryLocked(current) }
        )
        if committed { scheduleRetentionLocked(current) }
    }

    private func removeAudioLocked(_ current: BridgeRecording) throws {
        if FileManager.default.fileExists(atPath: current.url.path) {
            try FileManager.default.removeItem(at: current.url)
            try syncRuntimeDirectory()
        }
        guard !FileManager.default.fileExists(atPath: current.url.path) else { throw CompanionFailure.unsafeStorage }
    }

    private func expireLocked(_ current: BridgeRecording) {
        guard current.state == "result-ready" else { return }
        let completedAt = current.terminalAt ?? Date().timeIntervalSince1970
        current.state = "expired"; current.length = nil; current.sha256 = nil
        current.terminalAt = completedAt + resultRetentionSeconds
        do {
            try persistLocked(current)
            try removeAudioLocked(current)
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
    private var requestReceiptsPath: String { runtime + "/request-receipts.json" }

    private func persistedValue(_ current: BridgeRecording) -> PersistedRecording {
        PersistedRecording(
            schemaVersion: 1, id: current.id, ownerId: current.ownerId,
            leaseHash: current.leaseHash.base64EncodedString(), state: current.state,
            length: current.length, sha256: current.sha256,
            completion: ["recording", "finalizing", "result-ready"].contains(current.state) ? current.completion : nil,
            terminalAt: current.terminalAt
        )
    }

    private func persistTransitionLocked(_ current: BridgeRecording, state: String, terminalAt: TimeInterval) throws {
        let value = PersistedRecording(
            schemaVersion: 1, id: current.id, ownerId: current.ownerId,
            leaseHash: current.leaseHash.base64EncodedString(), state: state,
            length: nil, sha256: nil, completion: nil, terminalAt: terminalAt
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
        let observationOperations = ["health", "levels", "status"]
        let controls = current.filter { !observationOperations.contains($0.operation) }
        let observations = current.filter { observationOperations.contains($0.operation) }
            .sorted { $0.receivedAt > $1.receivedAt }.prefix(maximumObservationRequestReceipts)
        requests = Dictionary(uniqueKeysWithValues: (controls + observations).map {
            ($0.ownerId + ":" + $0.requestId, $0)
        })
    }

    private func persistRequestReceiptsLocked() throws {
        pruneRequestReceiptsLocked()
        let value = PersistedRequestRegistry(
            schemaVersion: 2,
            receipts: requests.values.sorted { $0.receivedAt < $1.receivedAt }
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try atomicWrite(encoder.encode(value), to: requestReceiptsPath)
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
            name.range(of: "^request-receipts\\.json\\.tmp-[0-9A-Fa-f-]{36}$", options: .regularExpression) != nil {
            try manager.removeItem(atPath: runtime + "/" + name)
            removedTemporary = true
        }
        if removedTemporary { try syncRuntimeDirectory() }
        if manager.fileExists(atPath: requestReceiptsPath) {
            let data = try readPrivateData(requestReceiptsPath, maximumBytes: maximumRequestRegistryBytes)
            let registry = try JSONDecoder().decode(PersistedRequestRegistry.self, from: data)
            guard registry.schemaVersion == 2 else { throw CompanionFailure.unsafeStorage }
            let validStatuses = ["ok", "busy", "not-found", "request-conflict", "invalid-state", "failed"]
            var restoredKeys = Set<String>()
            for receipt in registry.receipts {
                let key = receipt.ownerId + ":" + receipt.requestId
                let responseShapeIsValid = receipt.responseStatus == nil && receipt.responsePayload == nil ||
                    receipt.responseStatus.map { validStatuses.contains($0) } == true && receipt.responsePayload != nil
                let responsePayloadIsValid = receipt.responsePayload.map {
                    ((try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]) != nil
                } ?? true
                guard UUID(uuidString: receipt.ownerId) != nil,
                      UUID(uuidString: receipt.requestId) != nil,
                      validRequestOperations.contains(receipt.operation),
                      receipt.contentHash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                      receipt.receivedAt.isFinite,
                      receipt.receivedAt <= Date().timeIntervalSince1970 + 60,
                      responseShapeIsValid, responsePayloadIsValid,
                      receipt.responsePayload.map({ $0.count <= maximumFrameBytes }) ?? true,
                      restoredKeys.insert(key).inserted else { throw CompanionFailure.unsafeStorage }
                if receipt.responseStatus != nil { requests[key] = receipt }
            }
            let observationOperations = ["health", "levels", "status"]
            guard requests.values.filter({ observationOperations.contains($0.operation) }).count <= maximumObservationRequestReceipts,
                  requests.values.filter({ !observationOperations.contains($0.operation) }).count <= maximumControlRequestReceipts else {
                throw CompanionFailure.unsafeStorage
            }
            pruneRequestReceiptsLocked()
            if requests.count != registry.receipts.count { try persistRequestReceiptsLocked() }
        }
        let metadataNames = names.filter {
            $0.range(of: "^recording-[0-9A-Fa-f-]{36}\\.json$", options: .regularExpression) != nil
        }
        for name in metadataNames {
            let path = runtime + "/" + name
            let data = try readPrivateData(path, maximumBytes: maximumFrameBytes)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(["schemaVersion", "id", "ownerId", "leaseHash", "state", "length", "sha256", "completion", "terminalAt"]).isSuperset(of: Set(object.keys)),
                  Set(["schemaVersion", "id", "ownerId", "leaseHash", "state"]).isSubset(of: Set(object.keys)) else {
                throw CompanionFailure.unsafeStorage
            }
            let persisted = try JSONDecoder().decode(PersistedRecording.self, from: data)
            let terminalStates = ["acknowledged", "cancelled", "expired", "failed"]
            let validShape = persisted.state == "result-ready"
                ? (persisted.length ?? 0) >= 44 && persisted.sha256?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil &&
                  ["stopped", "duration-limit"].contains(persisted.completion ?? "") && persisted.terminalAt != nil
                : terminalStates.contains(persisted.state)
                    ? persisted.length == nil && persisted.sha256 == nil && persisted.completion == nil && persisted.terminalAt != nil
                    : persisted.length == nil && persisted.sha256 == nil && persisted.terminalAt == nil
            guard persisted.schemaVersion == 1,
                  UUID(uuidString: persisted.id) != nil,
                  name == "recording-" + persisted.id + ".json",
                  UUID(uuidString: persisted.ownerId) != nil,
                  let leaseHash = Data(base64Encoded: persisted.leaseHash), leaseHash.count == 32,
                  ["recording", "finalizing", "result-ready", "acknowledged", "cancelled", "expired", "failed"].contains(persisted.state),
                  validShape, recordings[persisted.id] == nil else { throw CompanionFailure.unsafeStorage }
            let current = BridgeRecording(
                id: persisted.id, ownerId: persisted.ownerId, leaseHash: leaseHash,
                url: URL(fileURLWithPath: runtime + "/recording-" + persisted.id + ".wav"),
                state: persisted.state, length: persisted.length, sha256: persisted.sha256,
                completion: persisted.completion ?? "stopped", terminalAt: persisted.terminalAt
            )
            recordings[current.id] = current
            if ["recording", "finalizing"].contains(current.state) {
                recoverAsFailedLocked(current)
            } else if current.state == "result-ready" {
                guard let length = current.length, let sha256 = current.sha256,
                      (try? validateResultFile(current.url, length: length, sha256: sha256)) == true,
                      current.terminalAt != nil else {
                    recoverAsFailedLocked(current)
                    continue
                }
                enforceRetentionLocked(current)
                if recordings[current.id] != nil { scheduleRetentionLocked(current) }
            } else {
                try removeAudioLocked(current)
                guard current.terminalAt != nil else { throw CompanionFailure.unsafeStorage }
                enforceRetentionLocked(current)
                if recordings[current.id] != nil { scheduleRetentionLocked(current) }
            }
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
        if removedOrphan { try syncRuntimeDirectory() }
    }

    private func recoverAsFailedLocked(_ current: BridgeRecording) {
        failLocked(current)
    }

    private func validateResultFile(_ url: URL, length: Int, sha256: String) throws -> Bool {
        var info = stat()
        guard lstat(url.path, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), (info.st_mode & 0o777) == 0o600,
              info.st_nlink == 1, info.st_size == length else { return false }
        return try fileDigest(url) == sha256
    }
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
        let chunk = try handle.read(upToCount: 64 * 1024) ?? Data()
        if chunk.isEmpty { break }
        digest.update(data: chunk)
    }
    return Data(digest.finalize()).hex
}

private func readAuthenticatedRequest(_ descriptor: Int32, credentials: [String: Credential]) throws -> AuthenticatedRequest {
    let challenge = try randomChallenge()
    try writeFrame(descriptor, object: [
        "type": "challenge", "version": protocolVersion, "challenge": challenge.base64EncodedString()
    ])
    let request = try readFrame(descriptor)
    try requireStreamEnd(descriptor)
    let required: Set<String> = ["type", "version", "credentialId", "requestId", "operation", "payload", "hmac"]
    guard exactKeys(request, required),
          request["type"] as? String == "request",
          request["version"] as? Int == protocolVersion,
          let credentialId = request["credentialId"] as? String,
          let credential = credentials[credentialId],
          let secret = Data(base64Encoded: credential.secret),
          let requestId = request["requestId"] as? String,
          UUID(uuidString: requestId) != nil,
          let operation = request["operation"] as? String,
          let payloadText = request["payload"] as? String,
          let payloadData = Data(base64Encoded: payloadText),
          let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
          let tagText = request["hmac"] as? String,
          let tag = Data(hex: tagText) else { throw CompanionFailure.authentication }
    let expected = authenticationTag(secret: secret, fields: [
        utf8("request"), utf8(String(protocolVersion)), challenge, utf8(credential.id),
        utf8(requestId), utf8(operation), payloadData
    ])
    guard constantTimeEqual(tag, expected) else { throw CompanionFailure.authentication }
    return AuthenticatedRequest(
        credential: credential, secret: secret, challenge: challenge,
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
        utf8("response"), utf8(String(protocolVersion)), request.challenge, utf8(request.credential.id),
        utf8(request.requestId), utf8(request.operation + ":" + status), payload
    ])
    try writeFrame(descriptor, object: [
        "type": "response", "version": protocolVersion, "requestId": request.requestId,
        "status": status, "payload": payload.base64EncodedString(), "hmac": responseTag.hex
    ])
}

private func requestLease(_ payload: [String: Any]) throws -> (id: String, leaseSecret: Data) {
    guard let id = payload["recordingId"] as? String, UUID(uuidString: id) != nil,
          let leaseText = payload["leaseSecret"] as? String,
          let leaseSecret = Data(base64Encoded: leaseText), leaseSecret.count == 32 else {
        throw CompanionFailure.invalidFrame
    }
    return (id, leaseSecret)
}

private func setSendTimeout(_ descriptor: Int32, seconds: Int) throws {
    var timeout = timeval(tv_sec: seconds, tv_usec: 0)
    guard setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                     socklen_t(MemoryLayout<timeval>.size)) == 0 else {
        throw CompanionFailure.invalidSocket
    }
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
    guard validRequestOperations.contains(request.operation) else {
        try writeAuthenticatedResponse(descriptor, request: request, status: "failed", payloadObject: [:])
        return
    }
    let replay: (String, [String: Any])?
    do {
        replay = try recordings.register(ownerId: request.credential.id, requestId: request.requestId,
                                         operation: request.operation, payload: request.payloadData)
    } catch CompanionFailure.requestConflict {
        try writeAuthenticatedResponse(descriptor, request: request, status: "request-conflict", payloadObject: [:])
        return
    } catch {
        try writeAuthenticatedResponse(descriptor, request: request, status: "failed", payloadObject: [:])
        return
    }
    if let replay {
        var replayURL: URL?
        if request.operation == "fetch", replay.0 == "ok" {
            guard exactKeys(request.payload, ["recordingId", "leaseSecret"]) else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            replayURL = try recordings.fetch(id: owned.id, ownerId: request.credential.id,
                                             leaseSecret: owned.leaseSecret).url
            try setSendTimeout(descriptor, seconds: 10)
        }
        try writeAuthenticatedResponse(descriptor, request: request, status: replay.0, payloadObject: replay.1)
        if let replayURL { try streamFile(descriptor, url: replayURL) }
        return
    }

    var status = "ok"
    var payload: [String: Any] = [:]
    var streamURL: URL?
    do {
        switch request.operation {
        case "health":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            payload = [
                "permission": permissionName(AVCaptureDevice.authorizationStatus(for: .audio)),
                "defaultInputAvailable": AVCaptureDevice.default(for: .audio) != nil,
            ]
        case "start":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "maxDurationMs"]),
                  let id = request.payload["recordingId"] as? String, UUID(uuidString: id) != nil,
                  let leaseText = request.payload["leaseSecret"] as? String,
                  let leaseSecret = Data(base64Encoded: leaseText), leaseSecret.count == 32,
                  let maximumDurationMs = request.payload["maxDurationMs"] as? Int else { throw CompanionFailure.invalidFrame }
            payload = try recordings.start(id: id, ownerId: request.credential.id,
                                           leaseSecret: leaseSecret, maximumDurationMs: maximumDurationMs)
        case "levels":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "afterSequence"]),
                  let after = request.payload["afterSequence"] as? Int else { throw CompanionFailure.invalidFrame }
            let owned = try requestLease(request.payload)
            let values = try recordings.levels(id: owned.id, ownerId: request.credential.id,
                                                leaseSecret: owned.leaseSecret, after: after)
            payload = ["observations": values]
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
            let result = try recordings.fetch(id: owned.id, ownerId: request.credential.id, leaseSecret: owned.leaseSecret)
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
    } catch {
        status = "failed"
    }
    try recordings.recordResponse(ownerId: request.credential.id, requestId: request.requestId,
                                  status: status, payload: payload)
    if streamURL != nil { try setSendTimeout(descriptor, seconds: 10) }
    try writeAuthenticatedResponse(descriptor, request: request, status: status, payloadObject: payload)
    if let streamURL { try streamFile(descriptor, url: streamURL) }
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
    let recordings = try RecordingManager(runtime: paths.runtime)
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
        guard hex.count == 64 else { return nil }
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
