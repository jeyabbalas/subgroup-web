"""Export pysubgroup's bundled datasets (titanic, credit-g) to committed CSVs.

The CSVs written here are the canonical inputs for BOTH sides of the
differential harness: gen_differential_fixtures.py reads them back through
pandas, and subgroup-web's fromCSV reads the identical bytes. They are also
the demo app's sample datasets.

Deterministic preprocessing (documented in reference/README.md):
- titanic: pysubgroup's bundled tab-separated titanic.csv, re-emitted as
  comma-separated RFC-4180 CSV (pandas default quoting, '\n' terminator).
- credit-g: pysubgroup's bundled ARFF via scipy.io.arff; byte-string columns
  are decoded to UTF-8 strings (the only lossless normalization), then
  emitted the same way.
"""

import json
import os

from common import DATASETS, dump_json, sha256_file, versions
from pysubgroup.datasets import get_credit_data, get_titanic_data


def export(name, df):
    path = os.path.join(DATASETS, f"{name}.csv")
    df.to_csv(path, index=False, lineterminator="\n")
    return {
        "file": f"{name}.csv",
        "sha256": sha256_file(path),
        "rows": int(df.shape[0]),
        "cols": int(df.shape[1]),
        "columns": [{"name": str(c), "dtype": str(df[c].dtype)} for c in df.columns],
    }


def main():
    os.makedirs(DATASETS, exist_ok=True)

    titanic = get_titanic_data()

    credit = get_credit_data()
    for col in credit.columns:
        if credit[col].dtype == object:
            credit[col] = credit[col].map(
                lambda v: v.decode("utf-8") if isinstance(v, bytes) else v
            )

    manifest = {
        "generator": "reference/scripts/export_datasets.py",
        "versions": versions(),
        "datasets": [export("titanic", titanic), export("credit-g", credit)],
    }
    dump_json(os.path.join(DATASETS, "manifest.json"), manifest)
    print(json.dumps(manifest["datasets"], indent=1))


if __name__ == "__main__":
    main()
