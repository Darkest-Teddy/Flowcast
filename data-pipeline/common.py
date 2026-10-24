"""Shared public-source fetching, provenance, and JSON command-line output."""

import argparse
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache" / "sources"
OUTPUT = ROOT / "output"
USER_AGENT = "FlowcastResearch/1.0 (public aggregate campus data; cached requests)"


class ScrapeError(ValueError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def stable_id(*parts):
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:20]


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
        temp = out.name
        try:
            json.dump(value, out, indent=2, ensure_ascii=False, allow_nan=False)
            out.write("\n")
        except Exception:
            os.unlink(temp)
            raise
    os.replace(temp, path)


@dataclass
class Source:
    url: str
    body: bytes
    fetched_at: str
    content_type: str = "text/html; charset=utf-8"
    cache_path: str | None = None
    cached: bool = False
    requested_url: str | None = None

    @property
    def text(self):
        encoding = "utf-8"
        for part in self.content_type.split(";")[1:]:
            if part.strip().lower().startswith("charset="):
                encoding = part.split("=", 1)[1].strip().strip('"')
        try:
            return self.body.decode(encoding, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")

    @property
    def provenance(self):
        return {
            "url": self.url,
            "requestedUrl": self.requested_url or self.url,
            "retrievedAt": self.fetched_at,
            "sha256": hashlib.sha256(self.body).hexdigest(),
            "contentType": self.content_type,
            "rawPath": self.cache_path,
            "cacheUsed": self.cached,
        }


class Fetcher:
    def __init__(self, cache_dir=CACHE, offline=False, refresh=False, delay=0.5, timeout=30):
        if offline and refresh:
            raise ScrapeError("--offline and --refresh cannot be combined")
        if delay < 0 or timeout <= 0:
            raise ScrapeError("Delay must be nonnegative and timeout positive")
        self.cache_dir = Path(cache_dir)
        self.offline, self.refresh = offline, refresh
        self.delay, self.timeout = delay, timeout
        self.last_request = {}
        self.responses = {}

    def get(self, url):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
            raise ScrapeError(f"Not a public HTTP(S) URL: {url}")
        if url in self.responses:
            return replace(self.responses[url], cached=True)
        key = hashlib.sha256(url.encode()).hexdigest()
        body_path = self.cache_dir / f"{key}.body"
        meta_path = self.cache_dir / f"{key}.json"
        if body_path.exists() and meta_path.exists() and not self.refresh:
            try:
                meta = json.loads(meta_path.read_text())
                body = body_path.read_bytes()
                if hashlib.sha256(body).hexdigest() != meta["sha256"]:
                    raise ScrapeError(f"Cache checksum mismatch: {url}")
                source = Source(meta["url"], body, meta["retrievedAt"], meta["contentType"],
                                str(body_path.resolve()), True, url)
                self.responses[url] = source
                return source
            except (KeyError, json.JSONDecodeError) as exc:
                raise ScrapeError(f"Invalid cache metadata for {url}: {exc}") from exc
        if self.offline:
            raise ScrapeError(f"No cached response for {url}; run online first")
        for attempt in range(3):
            elapsed = time.monotonic() - self.last_request.get(parsed.netloc, 0)
            time.sleep(max(0, self.delay - elapsed))
            self.last_request[parsed.netloc] = time.monotonic()
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read()
                    source = Source(response.url, body, utc_now(), response.headers.get("Content-Type", ""),
                                    str(body_path.resolve()), False, url)
                break
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    retry = exc.headers.get("Retry-After", "")
                    time.sleep(min(30, int(retry)) if retry.isdigit() else 2 ** attempt)
                    continue
                raise ScrapeError(f"HTTP {exc.code} fetching {url}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise ScrapeError(f"Cannot fetch {url}: {exc}") from exc
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        # Publish metadata last, so an interrupted response is never a complete cache entry.
        body_path.write_bytes(body)
        write_json(meta_path, source.provenance)
        self.responses[url] = source
        return source


def soup(source):
    return BeautifulSoup(source.text, "html.parser")


def main_content(source):
    document = soup(source)
    content = document.select_one("main, article, #content, .content") or document
    for node in content.select("script, style, nav, footer, header"):
        node.decompose()
    return content


def envelope(name, result):
    errors = result.get("errors", [])
    return {
        "schemaVersion": 1,
        "dataset": name,
        "generatedAt": utc_now(),
        "timezone": "America/New_York",
        "status": "partial" if errors else "ok",
        **result,
    }


def run_cli(name, collect, add_arguments=None):
    parser = argparse.ArgumentParser(description=collect.__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT / f"{name}.json")
    parser.add_argument("--cache-dir", type=Path, default=CACHE)
    parser.add_argument("--offline", action="store_true", help="Use only cached source responses")
    parser.add_argument("--refresh", action="store_true", help="Fetch again; keep original retrieval dates otherwise")
    parser.add_argument("--delay", type=float, default=0.5, help="Minimum seconds between requests per host")
    if add_arguments:
        add_arguments(parser)
    args = vars(parser.parse_args())
    output = args.pop("output")
    try:
        fetcher = Fetcher(**{key: args.pop(key) for key in ("cache_dir", "offline", "refresh", "delay")})
        result = collect(fetcher, **args)
    except (ScrapeError, OSError) as exc:
        parser.exit(1, f"{name}: {exc}\n")
    payload = envelope(name, result)
    write_json(output, payload)
    print(f"{name}: {payload['status']} -> {output}")
    if result.get("errors"):
        parser.exit(1, "Some sources failed; see errors in the output.\n")
