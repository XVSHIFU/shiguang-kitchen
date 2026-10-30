"""Password hashing + token hashing.

Primary: argon2id (argon2-cffi). Fallback: bcrypt, then hashlib
pbkdf2_hmac (see ADR-0005). Passwords are never stored in plaintext.
"""
import hashlib
import hmac
import secrets

try:
    from argon2 import PasswordHasher as _ArgonHasher
    from argon2.exceptions import VerifyMismatchError as _ArgonMismatch

    _argon = _ArgonHasher()
    _BACKEND = "argon2id"
except Exception:  # pragma: no cover - environment without argon2
    _argon = None
    _BACKEND = "pbkdf2"

try:
    import bcrypt as _bcrypt
except Exception:  # pragma: no cover
    _bcrypt = None


def hash_password(password: str) -> str:
    if _argon is not None:
        return "argon2$" + _argon.hash(password)
    if _bcrypt is not None:
        return "bcrypt$" + _bcrypt.hashpw(password.encode(), _bcrypt.gensalt()).decode()
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600_000)
    return f"pbkdf2$600000${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        if stored.startswith("argon2$"):
            if _argon is None:
                return False
            try:
                return _argon.verify(stored[len("argon2$"):], password)
            except _ArgonMismatch:
                return False
        if stored.startswith("bcrypt$"):
            if _bcrypt is None:
                return False
            return _bcrypt.checkpw(password.encode(), stored[len("bcrypt$"):].encode())
        if stored.startswith("pbkdf2$"):
            _, iters, salt, hexdk = stored.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iters))
            return hmac.compare_digest(dk.hex(), hexdk)
    except Exception:
        return False
    return False


def password_backend() -> str:
    return _BACKEND


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def payload_hash(payload: dict) -> str:
    import json

    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()
