"""Fixed macOS Keychain Services helper. Secret bytes use stdin/stdout only.
No shell, password argument, file vault, account search or logging.
"""
import ctypes as C
import re
import sys


def main():
    if sys.platform != 'darwin' or len(sys.argv) != 4:
        raise ValueError()
    action, service, account = sys.argv[1:]
    if action not in ('store', 'get', 'delete') or not re.fullmatch(r'online\.gustav\.model-bridge\.[a-f0-9]{64}', service) or not re.fullmatch(r'native_[a-f0-9]{32}_[a-f0-9]{64}', account):
        raise ValueError()
    cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    sec = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
    P = C.c_void_p
    cf.CFStringCreateWithCString.argtypes = [P, C.c_char_p, C.c_uint32]
    cf.CFStringCreateWithCString.restype = P
    cf.CFDictionaryCreate.argtypes = [P, C.POINTER(P), C.POINTER(P), C.c_long, P, P]
    cf.CFDictionaryCreate.restype = P
    cf.CFDataCreate.argtypes = [P, P, C.c_long]
    cf.CFDataCreate.restype = P
    cf.CFDataGetLength.argtypes = [P]
    cf.CFDataGetLength.restype = C.c_long
    cf.CFDataGetBytePtr.argtypes = [P]
    cf.CFDataGetBytePtr.restype = P
    cf.CFRelease.argtypes = [P]
    sec.SecItemAdd.argtypes = [P, C.POINTER(P)]
    sec.SecItemCopyMatching.argtypes = [P, C.POINTER(P)]
    sec.SecItemDelete.argtypes = [P]
    owned = []

    def constant(name, lib=sec):
        return P.in_dll(lib, name).value

    def string(value):
        p = cf.CFStringCreateWithCString(None, value.encode('utf-8'), 0x08000100)
        if not p:
            raise ValueError()
        owned.append(p)
        return p

    pairs = [(constant('kSecClass'), constant('kSecClassGenericPassword')),
             (constant('kSecAttrService'), string(service)),
             (constant('kSecAttrAccount'), string(account))]
    token = None
    if action == 'store':
        token = sys.stdin.buffer.read(4097)
        if not re.fullmatch(rb'[\x21-\x7e]{1,4096}', token):
            raise ValueError()
        value = cf.CFDataCreate(None, C.cast(C.c_char_p(token), P), len(token))
        owned.append(value)
        pairs.append((constant('kSecValueData'), value))
    elif action == 'get':
        pairs.extend([(constant('kSecReturnData'), constant('kCFBooleanTrue', cf)),
                      (constant('kSecMatchLimit'), constant('kSecMatchLimitOne'))])
    keys = (P * len(pairs))(*(k for k, _ in pairs))
    values = (P * len(pairs))(*(v for _, v in pairs))
    query = cf.CFDictionaryCreate(None, keys, values, len(pairs), None, None)
    result = P()
    try:
        status = sec.SecItemAdd(query, None) if action == 'store' else sec.SecItemDelete(query) if action == 'delete' else sec.SecItemCopyMatching(query, C.byref(result))
        if status != 0:
            raise ValueError()
        if action == 'get':
            length = cf.CFDataGetLength(result)
            if not 0 < length <= 4096:
                raise ValueError()
            token = C.string_at(cf.CFDataGetBytePtr(result), length)
            if not re.fullmatch(rb'[\x21-\x7e]{1,4096}', token):
                raise ValueError()
            sys.stdout.buffer.write(token)
    finally:
        if result.value:
            cf.CFRelease(result)
        cf.CFRelease(query)
        for p in owned:
            cf.CFRelease(p)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Native credential storage unavailable.\n')
        sys.exit(90)
