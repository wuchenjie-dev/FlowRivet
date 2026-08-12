import Foundation
import Security

let arguments = CommandLine.arguments
guard arguments.count == 4 else { exit(2) }
let operation = arguments[1]
let service = arguments[2]
let account = arguments[3]
let base: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch operation {
case "write":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    SecItemDelete(base as CFDictionary)
    var query = base
    query[kSecValueData as String] = secret
    exit(SecItemAdd(query as CFDictionary, nil) == errSecSuccess ? 0 : 4)
case "read":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { exit(3) }
    guard status == errSecSuccess, let data = item as? Data else { exit(4) }
    FileHandle.standardOutput.write(data)
case "delete":
    let status = SecItemDelete(base as CFDictionary)
    exit(status == errSecSuccess || status == errSecItemNotFound ? 0 : 4)
default:
    exit(2)
}
