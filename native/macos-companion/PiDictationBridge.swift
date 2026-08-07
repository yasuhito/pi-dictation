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
private let resultRetentionSeconds: TimeInterval = 5 * 60
#if PI_DICTATION_INTEGRATION_TEST
private let usesSyntheticCapture = true
#else
private let usesSyntheticCapture = false
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
        for credentialName in ["credential.json", "credential.next.json"] {
            let credentialPath = directory + "/" + credentialName
            var credentialInfo = stat()
            if lstat(credentialPath, &credentialInfo) != 0 {
                guard errno == ENOENT else { throw CompanionFailure.unsafeStorage }
                continue
            }
            let credential: Credential
            do {
                credential = try readCredential(credentialPath)
            } catch {
                continue
            }
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

private final class BridgeRecording {
    let id: String
    let ownerId: String
    let leaseHash: Data
    let url: URL
    let recorder: AVAudioRecorder
    var state = "recording"
    var length: Int?
    var sha256: String?
    var completion = "stopped"
    var observations: [[String: Any]] = []
    var sequence = 0
    var levelTimer: DispatchSourceTimer?
    var durationTimer: DispatchWorkItem?
    var retentionTimer: DispatchWorkItem?

    init(id: String, ownerId: String, leaseHash: Data, url: URL, recorder: AVAudioRecorder) {
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
    private var connections: [String: Set<Int32>] = [:]
    private var revokedOwners: Set<String> = []

    init(runtime: String) { self.runtime = runtime }

    func openConnection(ownerId: String, descriptor: Int32) {
        lock.lock()
        connections[ownerId, default: []].insert(descriptor)
        lock.unlock()
    }

    func closeConnection(ownerId: String, descriptor: Int32) {
        lock.lock()
        connections[ownerId]?.remove(descriptor)
        if connections[ownerId]?.isEmpty == true { connections.removeValue(forKey: ownerId) }
        lock.unlock()
    }

    private func effects(ownerId: String, currentDescriptor: Int32) -> ([BridgeRecording], [Int32], [String: Any]) {
        let owned = recordings.values.filter { $0.ownerId == ownerId }
        let active = owned.filter { $0.state == "recording" || $0.state == "finalizing" }.count
        let retained = owned.filter { $0.state == "result-ready" }.count
        let ownedConnections = Array((connections[ownerId] ?? []).filter { $0 != currentDescriptor })
        return (owned, ownedConnections, [
            "connections": ownedConnections.count,
            "activeRecordingLease": active,
            "incompleteAudio": active,
            "retainedWav": retained,
        ])
    }

    func credentialEffects(ownerId: String, currentDescriptor: Int32) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return effects(ownerId: ownerId, currentDescriptor: currentDescriptor).2
    }

    func revokeCredential(ownerId: String, currentDescriptor: Int32, onlyIfIdle: Bool) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        if onlyIfIdle && revokedOwners.contains(ownerId) {
            return ["connections": 0, "activeRecordingLease": 0, "incompleteAudio": 0, "retainedWav": 0]
        }
        let (owned, ownedConnections, result) = effects(ownerId: ownerId, currentDescriptor: currentDescriptor)
        if onlyIfIdle && ((result["activeRecordingLease"] as? Int ?? 0) > 0 ||
                          (result["incompleteAudio"] as? Int ?? 0) > 0 ||
                          (result["retainedWav"] as? Int ?? 0) > 0) {
            throw CompanionFailure.invalidState
        }
        revokedOwners.insert(ownerId)
        for descriptor in ownedConnections { shutdown(descriptor, SHUT_RDWR) }
        for recording in owned {
            recording.durationTimer?.cancel()
            recording.levelTimer?.cancel()
            recording.retentionTimer?.cancel()
            if recording.state == "recording" { recording.recorder.stop() }
            do {
                if FileManager.default.fileExists(atPath: recording.url.path) {
                    try FileManager.default.removeItem(at: recording.url)
                }
            } catch {
                revokedOwners.remove(ownerId)
                throw CompanionFailure.failed
            }
        }
        for recording in owned {
            recordings.removeValue(forKey: recording.id)
            if activeId == recording.id { activeId = nil }
        }
        requests = requests.filter { !$0.key.hasPrefix(ownerId + ":") }
        busyStartRequests = Set(busyStartRequests.filter { !$0.hasPrefix(ownerId + ":") })
        return result
    }

    func register(ownerId: String, requestId: String, operation: String, payload: Data) throws {
        var digest = SHA256()
        digest.update(data: Data(operation.utf8))
        digest.update(data: Data([0]))
        digest.update(data: payload)
        let content = Data(digest.finalize())
        let key = ownerId + ":" + requestId
        lock.lock()
        defer { lock.unlock() }
        if revokedOwners.contains(ownerId) {
            if operation == "credential-revoke-if-idle" { return }
            throw CompanionFailure.notFound
        }
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
        if revokedOwners.contains(ownerId) { throw CompanionFailure.notFound }
        if busyStartRequests.contains(requestKey) { throw CompanionFailure.busy }
        let leaseHash = Data(SHA256.hash(data: leaseSecret))
        if let existing = recordings[id] {
            guard existing.ownerId == ownerId, constantTimeEqual(existing.leaseHash, leaseHash) else {
                throw CompanionFailure.notFound
            }
            return statusPayload(existing)
        }
        guard activeId == nil else {
            busyStartRequests.insert(requestKey)
            throw CompanionFailure.busy
        }
        guard maximumDurationMs >= 1000, maximumDurationMs <= 60 * 60 * 1000,
              usesSyntheticCapture || (AVCaptureDevice.authorizationStatus(for: .audio) == .authorized &&
                                       AVCaptureDevice.default(for: .audio) != nil) else {
            throw CompanionFailure.failed
        }
        let maximumBytes = Int64(maximumDurationMs) * 32 + Int64(maximumFrameBytes)
        let capacity = try URL(fileURLWithPath: runtime).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard capacity >= maximumBytes else { throw CompanionFailure.failed }
        let url = URL(fileURLWithPath: runtime + "/recording-" + id + ".wav")
        var existing = stat()
        guard lstat(url.path, &existing) != 0, errno == ENOENT else { throw CompanionFailure.unsafeStorage }
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM), AVSampleRateKey: 16000.0,
            AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        let audioRecorder = try AVAudioRecorder(url: url, settings: settings)
        audioRecorder.isMeteringEnabled = true
        if usesSyntheticCapture {
            let syntheticWav = Data([
                0x52, 0x49, 0x46, 0x46, 0x26, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
                0x66, 0x6d, 0x74, 0x20, 0x10, 0, 0, 0, 1, 0, 1, 0,
                0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 0x10, 0,
                0x64, 0x61, 0x74, 0x61, 2, 0, 0, 0, 1, 0,
            ])
            try syntheticWav.write(to: url)
            guard chmod(url.path, S_IRUSR | S_IWUSR) == 0 else { throw CompanionFailure.failed }
        } else if !audioRecorder.prepareToRecord() || chmod(url.path, S_IRUSR | S_IWUSR) != 0 || !audioRecorder.record() {
            try? FileManager.default.removeItem(at: url)
            throw CompanionFailure.failed
        }
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
        current.recorder.updateMeters()
        let power = current.recorder.averagePower(forChannel: 0)
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
        current.recorder.stop()
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
        current.durationTimer?.cancel(); current.levelTimer?.cancel(); current.recorder.stop()
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
    recordings.openConnection(ownerId: request.credential.id, descriptor: descriptor)
    defer { recordings.closeConnection(ownerId: request.credential.id, descriptor: descriptor) }
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
        case "credential-effects":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject:
                recordings.credentialEffects(ownerId: request.credential.id, currentDescriptor: descriptor))
        case "credential-revoke", "credential-revoke-if-idle":
            guard request.payload.isEmpty else { throw CompanionFailure.invalidFrame }
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject:
                try recordings.revokeCredential(ownerId: request.credential.id, currentDescriptor: descriptor,
                                                onlyIfIdle: request.operation == "credential-revoke-if-idle"))
        case "start":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "maxDurationMs"]),
                  let id = request.payload["recordingId"] as? String, UUID(uuidString: id) != nil,
                  let leaseText = request.payload["leaseSecret"] as? String,
                  let leaseSecret = Data(base64Encoded: leaseText), leaseSecret.count == 32,
                  let maximumDurationMs = request.payload["maxDurationMs"] as? Int else { throw CompanionFailure.invalidFrame }
            let payload = try recordings.start(id: id, ownerId: request.credential.id, requestId: request.requestId,
                                               leaseSecret: leaseSecret, maximumDurationMs: maximumDurationMs)
            try writeAuthenticatedResponse(descriptor, request: request, payloadObject: payload)
        case "levels":
            guard exactKeys(request.payload, ["recordingId", "leaseSecret", "afterSequence"]),
                  let after = request.payload["afterSequence"] as? Int else { throw CompanionFailure.invalidFrame }
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
            do {
                let credentials = try readCredentials(primary: paths.credential, hosts: paths.hostCredentials)
                try handleRequest(client, credentials: credentials, recordings: recordings)
            } catch { }
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
#if PI_DICTATION_INTEGRATION_TEST
    FileHandle.standardError.write(Data("\(error)\n".utf8))
#endif
    exit(EXIT_FAILURE)
}
