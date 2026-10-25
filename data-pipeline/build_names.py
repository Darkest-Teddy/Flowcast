"""Popular first names for the map's people, by gender.

Source: US Social Security Administration baby names (national data), via the `babynames`
dataset (github.com/hadley/babynames, data/babynames.rda), which republishes the SSA files
(ssa.gov blocks scripted downloads). Births 2003-2008 are pooled: the age of most students in 2026.
Names used by both sexes are left out: a name counts for a sex only if at least 90% of the babies
given it in those years were that sex, so a name always matches its character's gender.

    python3 -m venv /tmp/v && /tmp/v/bin/pip install rdata
    gh api -H "Accept: application/vnd.github.raw" repos/hadley/babynames/contents/data/babynames.rda > /tmp/babynames.rda
    /tmp/v/bin/python -I data-pipeline/build_names.py /tmp/babynames.rda

Writes map-client/public/data/names.json: {"female": [500 names], "male": [500 names], ...}.
"""
import json
import sys
from collections import Counter
from pathlib import Path

import rdata

YEARS = range(2003, 2009)
PER_SEX = 500
MIN_SHARE = 0.9
OUT = Path(__file__).resolve().parents[1] / "map-client" / "public" / "data" / "names.json"


def main(path):
    df = rdata.conversion.convert(rdata.parser.parse_file(path))["babynames"]
    df = df[(df["year"] >= YEARS.start) & (df["year"] < YEARS.stop)]
    counts = {"F": Counter(), "M": Counter()}
    for sex, name, n in zip(df["sex"], df["name"], df["n"]):
        counts[str(sex)][str(name)] += int(n)
    out = {}
    for sex, key in (("F", "female"), ("M", "male")):
        other = counts["M" if sex == "F" else "F"]
        ranked = [name for name, n in counts[sex].most_common() if n / (n + other[name]) >= MIN_SHARE]
        out[key] = ranked[:PER_SEX]
    out["source"] = ("US Social Security Administration baby names (national), births "
                     f"{YEARS.start}-{YEARS.stop - 1}, via github.com/hadley/babynames; top {PER_SEX} per sex, "
                     f"names at least {MIN_SHARE:.0%} one sex")
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"{len(out['female'])} female, {len(out['male'])} male -> {OUT}")
    print("female:", ", ".join(out["female"][:12]), "...")
    print("male:", ", ".join(out["male"][:12]), "...")


if __name__ == "__main__":
    main(sys.argv[1])
