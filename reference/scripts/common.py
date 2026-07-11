"""Shared helpers for the reference harness scripts."""

import hashlib
import json
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROOT)
DATASETS = os.path.join(ROOT, "datasets")
FIXTURES = os.path.join(ROOT, "fixtures")
CACHE = os.path.join(ROOT, ".cache")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sanitize(obj):
    """Make an object JSON-safe: tag non-finite floats, unwrap numpy scalars.

    NaN/inf become {"$f": "nan" | "inf" | "-inf"} so the TS side can decode
    them without relying on non-standard JSON.
    """
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, float):
        if math.isnan(obj):
            return {"$f": "nan"}
        if math.isinf(obj):
            return {"$f": "inf" if obj > 0 else "-inf"}
        return obj
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8")
    return obj


def dump_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sanitize(obj), f, indent=1, allow_nan=False, sort_keys=False)
        f.write("\n")


def versions():
    from importlib.metadata import version

    import pandas
    import numpy as np2
    import scipy

    return {
        "pysubgroup": version("pysubgroup"),
        "pandas": pandas.__version__,
        "numpy": np2.__version__,
        "scipy": scipy.__version__,
    }
