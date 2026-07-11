"""Fetch the UCI Adult dataset (~48.8k rows) into a git-ignored cache.

Deterministic preprocessing recipe (BRIEF §6.4/§14):
1. Download adult.data (32561 rows) and adult.test (16281 rows) from the UCI
   archive; verify SHA-256 of the raw downloads.
2. Parse both with the canonical 15 column names; adult.test's leading
   '|1x3 Cross validator' line is skipped.
3. Strip surrounding whitespace from every string cell; map '?' to NA.
4. Normalize the income label: strip trailing '.' (present only in the test
   split) -> values '<=50K' / '>50K'.
5. Concatenate train then test, in file order; write reference/.cache/adult.csv
   (pandas to_csv, index=False, '\n' terminator).

The resulting CSV's SHA-256 is recorded in reference/datasets/adult.manifest.json
(committed) and re-verified on every fetch.
"""

import io
import json
import os
import urllib.request

import pandas as pd

from common import CACHE, DATASETS, dump_json, sha256_file

URLS = {
    "adult.data": "https://archive.ics.uci.edu/ml/machine-learning-databases/adult/adult.data",
    "adult.test": "https://archive.ics.uci.edu/ml/machine-learning-databases/adult/adult.test",
}

# Raw-download hashes are pinned in reference/datasets/adult.manifest.json on
# first fetch and verified on every later fetch (same pattern as the CSV).
RAW_SHA256_KEY = "raw_sha256"

COLUMNS = [
    "age",
    "workclass",
    "fnlwgt",
    "education",
    "education-num",
    "marital-status",
    "occupation",
    "relationship",
    "race",
    "sex",
    "capital-gain",
    "capital-loss",
    "hours-per-week",
    "native-country",
    "income",
]


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    raw_path = os.path.join(CACHE, name)
    if not os.path.exists(raw_path):
        print(f"downloading {URLS[name]} ...")
        with urllib.request.urlopen(URLS[name]) as resp:
            data = resp.read()
        with open(raw_path, "wb") as f:
            f.write(data)
    return raw_path


def parse(path, skip_first_line):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if skip_first_line:
        text = text.split("\n", 1)[1]
    df = pd.read_csv(
        io.StringIO(text),
        header=None,
        names=COLUMNS,
        skipinitialspace=True,
        na_values=["?"],
        skip_blank_lines=True,
    )
    df["income"] = df["income"].str.rstrip(".")
    return df


def main():
    raw_train = fetch("adult.data")
    raw_test = fetch("adult.test")
    raw_hashes = {"adult.data": sha256_file(raw_train), "adult.test": sha256_file(raw_test)}

    train = parse(raw_train, skip_first_line=False)
    test = parse(raw_test, skip_first_line=True)
    df = pd.concat([train, test], ignore_index=True)
    out = os.path.join(CACHE, "adult.csv")
    df.to_csv(out, index=False, lineterminator="\n")
    sha = sha256_file(out)

    manifest_path = os.path.join(DATASETS, "adult.manifest.json")
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            recorded = json.load(f)
        if recorded["sha256"] != sha or recorded[RAW_SHA256_KEY] != raw_hashes:
            raise RuntimeError(
                f"adult sha256 mismatch: got csv={sha} raw={raw_hashes}, manifest says "
                f"csv={recorded['sha256']} raw={recorded[RAW_SHA256_KEY]}"
            )
        print(f"adult.csv verified against committed manifest ({sha})")
    else:
        dump_json(
            manifest_path,
            {
                "file": ".cache/adult.csv (git-ignored)",
                "sha256": sha,
                "rows": int(df.shape[0]),
                "cols": int(df.shape[1]),
                RAW_SHA256_KEY: raw_hashes,
            },
        )
        print(f"adult.csv manifest written ({sha})")
    print(f"rows={df.shape[0]} cols={df.shape[1]} -> {out}")


if __name__ == "__main__":
    main()
