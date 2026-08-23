"""Static file server with HTTP Range support (needed by pmtiles.js).

Usage: python3 serve.py [port]   (default 8471), then open
http://localhost:8471/
"""
import os, re, sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        if not m or not os.path.exists(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_len = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "_range_len", None)
        if n is None:
            return super().copyfile(source, outputfile)
        remaining = n
        while remaining > 0:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        self._range_len = None

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8471
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"serving http://localhost:{port}/")
    HTTPServer(("127.0.0.1", port), RangeHandler).serve_forever()
