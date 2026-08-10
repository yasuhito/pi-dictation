import Darwin

private func fail() -> Never { exit(EXIT_FAILURE) }

private func readLine(_ descriptor: Int32, maximumBytes: Int) -> String? {
    var bytes: [UInt8] = []
    while bytes.count < maximumBytes {
        var byte: UInt8 = 0
        let count = Darwin.read(descriptor, &byte, 1)
        if count != 1 { return nil }
        if byte == 0x0a { return String(decoding: bytes, as: UTF8.self) }
        bytes.append(byte)
    }
    return nil
}

private func writeLine(_ value: String) -> Bool {
    let bytes = Array((value + "\n").utf8)
    return bytes.withUnsafeBytes { buffer in
        Darwin.write(STDOUT_FILENO, buffer.baseAddress!, buffer.count) == buffer.count
    }
}

@main
private struct DurationWatchdog {
    static func main() {
        guard CommandLine.arguments.count == 3 || CommandLine.arguments.count == 4,
              let parent = Int32(CommandLine.arguments[1]), parent > 1,
              let durationMilliseconds = UInt64(CommandLine.arguments[2]), durationMilliseconds > 0 else { fail() }
#if WATCHDOG_TESTING
        let graceMilliseconds = CommandLine.arguments.count == 4 ? UInt64(CommandLine.arguments[3]) ?? 0 : 5_000
        guard graceMilliseconds > 0 else { fail() }
#else
        guard CommandLine.arguments.count == 3 else { fail() }
        let graceMilliseconds: UInt64 = 5_000
#endif
        guard getppid() == parent,
              let instanceToken = readLine(STDIN_FILENO, maximumBytes: 64),
              instanceToken.utf8.count == 36,
              instanceToken.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) || $0 == 0x2d }) else { fail() }
        usleep(useconds_t(min(durationMilliseconds, UInt64(UInt32.max / 1_000)) * 1_000))
        guard getppid() == parent, kill(parent, 0) == 0 else { exit(EXIT_SUCCESS) }
        guard writeLine(instanceToken) else { exit(EXIT_SUCCESS) }
        usleep(useconds_t(min(graceMilliseconds, UInt64(UInt32.max / 1_000)) * 1_000))
        guard getppid() == parent, kill(parent, 0) == 0 else { exit(EXIT_SUCCESS) }
        _ = kill(parent, SIGKILL)
    }
}
