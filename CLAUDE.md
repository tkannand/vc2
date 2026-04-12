# Project Instructions

## PWA Cache Busting

This app is a PWA with a service worker (`frontend/sw.js`). When deploying any update, always bump the `CACHE_NAME` version string in `frontend/sw.js` (e.g. `vc-v2` to `vc-v3`) so the service worker invalidates old caches and users get fresh files on their next visit.

## Tamil Encoding in CSV Files

Both CSVs use `encoding='latin-1'`. Tamil fields use a compact single-byte encoding — each byte maps to Tamil Unicode by adding `0x0B00` to the byte value:

```python
def _decode_tamil(text: str) -> str:
    result = []
    for ch in text:
        b = ord(ch)
        if b >= 0x80:
            result.append(chr(0x0B00 + b))  # e.g. 0x95 → U+0B95 = க
        else:
            result.append(ch)               # ASCII passes through unchanged
    return "".join(result).strip()
```

Always decode Tamil BEFORE calling `.strip()` — byte `0x85` (NEL) would be stripped raw but decodes correctly to U+0B85 = அ.
