"""Secret storage.

OAuth tokens and API secrets are stored in the OS keychain (Windows Credential
Manager via ``keyring``) rather than plaintext files — fixing a common weakness
in hobby assistants. If ``keyring`` or a backend is unavailable, we fall back to
a restricted-permission file under the credentials dir so the app still works,
and the caller is told it's the less-secure path.
"""

from __future__ import annotations

import json
import os
import stat

from nexus.kernel import paths

_SERVICE = "nexus-os"


def _keyring():
    try:
        import keyring  # noqa: PLC0415 - optional dependency, imported lazily
        return keyring
    except Exception:  # noqa: BLE001
        return None


def set_secret(key: str, value: str) -> bool:
    """Store a secret. Returns True if stored in the OS keychain."""
    kr = _keyring()
    if kr is not None:
        try:
            kr.set_password(_SERVICE, key, value)
            return True
        except Exception:  # noqa: BLE001
            pass
    _write_fallback(key, value)
    return False


def get_secret(key: str) -> str | None:
    kr = _keyring()
    if kr is not None:
        try:
            val = kr.get_password(_SERVICE, key)
            if val is not None:
                return val
        except Exception:  # noqa: BLE001
            pass
    return _read_fallback(key)


def delete_secret(key: str) -> None:
    kr = _keyring()
    if kr is not None:
        try:
            kr.delete_password(_SERVICE, key)
        except Exception:  # noqa: BLE001
            pass
    f = _fallback_path(key)
    if f.exists():
        f.unlink()


# --- restricted-file fallback -------------------------------------------------

def _fallback_path(key: str):
    safe = key.replace("/", "_").replace("\\", "_")
    return paths.credentials_dir() / f"{safe}.secret.json"


def _write_fallback(key: str, value: str) -> None:
    f = _fallback_path(key)
    f.write_text(json.dumps({"value": value}), encoding="utf-8")
    # Best-effort lock-down (effective on POSIX; on Windows ACLs differ but the
    # file already lives in a per-user profile directory).
    try:
        os.chmod(f, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def _read_fallback(key: str) -> str | None:
    f = _fallback_path(key)
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("value")
    except (OSError, json.JSONDecodeError):
        return None
