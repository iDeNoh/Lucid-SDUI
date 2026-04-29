"""
SDNext UI proxy server
- Serves index.html / style.css / app.js on http://localhost:8080
- Forwards all /sdapi/ requests to SDNext at http://localhost:7860
  so the browser sees everything as same-origin (no CORS issues)
"""
import http.server
import urllib.request
import urllib.error
import urllib.parse
import os
import json
import base64
import datetime
import struct
import webbrowser
import re
import glob as _glob
import random
import shutil

PORT = 8080
API_TARGET = 'http://localhost:7860'
DIR = os.path.dirname(os.path.abspath(__file__))
WILDCARDS_DIR = os.path.join(DIR, 'extras', 'wildcards')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress request noise

    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/sdapi/') or path == '/openapi.json':
            self._proxy()
        elif path == '/outputs/meta':
            self._output_meta()
        elif path == '/outputs':
            self._list_outputs()
        elif path == '/wildcards':
            self._wc_list()
        elif path == '/wildcards/content':
            self._wc_content()
        else:
            self._static(path)

    def _output_meta(self):
        qs  = urllib.parse.parse_qs(self.path.split('?', 1)[1] if '?' in self.path else '')
        rel = qs.get('path', [''])[0].replace('\\', '/').lstrip('/')
        outputs_dir = os.path.join(DIR, 'outputs')
        fp = os.path.normpath(os.path.join(outputs_dir, rel))
        try:
            safe = os.path.commonpath([fp, outputs_dir]) == outputs_dir
        except ValueError:
            safe = False
        if not safe or not os.path.isfile(fp):
            self.send_error(404)
            return
        meta   = self._png_text(fp)
        params = meta.get('parameters', '')
        resp   = json.dumps({'parameters': params}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def _png_text(self, filepath):
        # Pillow handles tEXt, iTXt, zTXt, and EXIF correctly
        try:
            from PIL import Image
            with Image.open(filepath) as img:
                result = {k: str(v) for k, v in img.info.items() if isinstance(v, (str, bytes))}
                if 'parameters' not in result:
                    # SDNext stores params in EXIF ExifIFD sub-directory (tag 34665 pointer)
                    try:
                        exif = img.getexif()
                        # Check main IFD tags 270 (ImageDescription) and 37510 (UserComment)
                        # then the ExifIFD sub-directory (tag 34665) for the same tags
                        def _extract_user_comment(uc):
                            if isinstance(uc, bytes):
                                if len(uc) > 8:
                                    prefix, text = uc[:8], uc[8:]
                                    if prefix[:7] == b'UNICODE':
                                        for enc in ('utf-16-le', 'utf-16-be', 'utf-16'):
                                            try:
                                                decoded = text.decode(enc).rstrip('\x00').strip()
                                                # Reject if mostly non-ASCII (wrong byte order)
                                                printable = sum(1 for c in decoded if ord(c) < 128)
                                                if decoded and printable / len(decoded) > 0.7:
                                                    return decoded
                                            except Exception:
                                                continue
                                    return text.decode('utf-8', errors='ignore').rstrip('\x00').strip()
                                return uc.decode('utf-8', errors='ignore').rstrip('\x00').strip()
                            # Pillow may return a pre-decoded string; strip embedded nulls
                            return str(uc).replace('\x00', '').strip() if uc else ''
                        def _extract_desc(d):
                            if isinstance(d, bytes):
                                return d.decode('utf-8', errors='ignore').rstrip('\x00').strip()
                            return str(d).strip() if d else ''
                        params = ''
                        for ifd in (exif, exif.get_ifd(34665)):
                            params = (
                                _extract_user_comment(ifd.get(37510)) or
                                _extract_desc(ifd.get(270))
                            )
                            if params:
                                break
                        if params:
                            result['parameters'] = params
                    except Exception:
                        pass
                return result
        except Exception:
            pass
        # Manual fallback: read tEXt and iTXt chunks
        result = {}
        try:
            with open(filepath, 'rb') as f:
                if f.read(8) != b'\x89PNG\r\n\x1a\n':
                    return result
                while True:
                    buf = f.read(8)
                    if len(buf) < 8:
                        break
                    (length,) = struct.unpack('>I', buf[:4])
                    ctype = buf[4:8].decode('ascii', errors='ignore')
                    data  = f.read(length)
                    f.read(4)  # CRC
                    if ctype == 'tEXt':
                        key, _, val = data.partition(b'\x00')
                        result[key.decode('latin-1', errors='ignore')] = val.decode('latin-1', errors='ignore')
                    elif ctype == 'iTXt':
                        try:
                            n1   = data.index(b'\x00')
                            key  = data[:n1].decode('utf-8', errors='ignore')
                            rest = data[n1 + 1:]
                            comp = rest[0] if rest else 0
                            rest = rest[2:]          # skip comp_flag + comp_method
                            n2   = rest.index(b'\x00')
                            rest = rest[n2 + 1:]     # skip language tag
                            n3   = rest.index(b'\x00')
                            text = rest[n3 + 1:]
                            if comp == 1:
                                import zlib
                                text = zlib.decompress(text)
                            result[key] = text.decode('utf-8', errors='ignore')
                        except Exception:
                            pass
                    elif ctype == 'IEND':
                        break
        except Exception:
            pass
        return result

    def _list_outputs(self):
        result = {}
        outputs_dir = os.path.join(DIR, 'outputs')
        if os.path.isdir(outputs_dir):
            for name in sorted(os.listdir(outputs_dir)):
                folder = os.path.join(outputs_dir, name)
                if os.path.isdir(folder):
                    files = sorted(
                        [f for f in os.listdir(folder) if f.lower().endswith('.png')],
                        reverse=True
                    )
                    if files:
                        result[name] = files
        resp = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def do_POST(self):
        if self.path == '/save':
            self._save()
        elif self.path.startswith('/sdapi/'):
            self._proxy()
        elif self.path == '/wildcards/save':
            self._wc_save()
        elif self.path == '/wildcards/delete':
            self._wc_delete()
        elif self.path == '/wildcards/mkdir':
            self._wc_mkdir()
        elif self.path == '/wildcards/move':
            self._wc_move()
        elif self.path == '/wildcards/resolve':
            self._wc_resolve()
        else:
            self.send_error(405)

    def _save(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length)
        try:
            data = json.loads(body)
        except Exception:
            self.send_error(400, 'Bad JSON')
            return

        img_type = data.get('type', 'txt2img')
        # Allow only safe folder names
        img_type = ''.join(c for c in img_type if c.isalnum() or c == '_') or 'output'
        b64      = data.get('image', '')

        out_dir = os.path.join(DIR, 'outputs', img_type)
        os.makedirs(out_dir, exist_ok=True)

        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        n  = 1
        while True:
            fname = f'{ts}_{n:03d}.png'
            if not os.path.exists(os.path.join(out_dir, fname)):
                break
            n += 1

        with open(os.path.join(out_dir, fname), 'wb') as f:
            f.write(base64.b64decode(b64))

        resp = json.dumps({'path': f'outputs/{img_type}/{fname}'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    # ── Wildcard helpers ──────────────────────────────────────────────────────

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        try:
            return json.loads(self.rfile.read(length))
        except Exception:
            return None

    def _wc_safe(self, rel):
        """Return absolute path if rel is safely inside WILDCARDS_DIR, else None."""
        rel = rel.replace('\\', '/').strip('/')
        fp  = os.path.normpath(os.path.join(WILDCARDS_DIR, rel))
        try:
            safe = os.path.commonpath([fp, WILDCARDS_DIR]) == WILDCARDS_DIR
        except ValueError:
            safe = False
        return fp if safe else None

    def _wc_list(self):
        result = {}
        if not os.path.isdir(WILDCARDS_DIR):
            self._send_json(result)
            return
        for root, dirs, files in os.walk(WILDCARDS_DIR):
            dirs.sort()
            rel = os.path.relpath(root, WILDCARDS_DIR).replace('\\', '/')
            if rel == '.':
                rel = ''
            txts = sorted(f[:-4] for f in files if f.lower().endswith('.txt'))
            result[rel] = txts
        self._send_json(result)

    def _wc_content(self):
        qs  = urllib.parse.parse_qs(self.path.split('?', 1)[1] if '?' in self.path else '')
        rel = qs.get('path', [''])[0]
        fp  = self._wc_safe(rel + '.txt') if rel else None
        if not fp or not os.path.isfile(fp):
            self.send_error(404)
            return
        with open(fp, 'r', encoding='utf-8') as f:
            content = f.read()
        self._send_json({'content': content})

    def _wc_save(self):
        data = self._read_json_body()
        if not data:
            self.send_error(400, 'Bad JSON')
            return
        rel  = data.get('path', '').strip('/')
        text = data.get('content', '')
        if not rel:
            self.send_error(400, 'Missing path')
            return
        fp = self._wc_safe(rel + '.txt')
        if not fp:
            self.send_error(403)
            return
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        with open(fp, 'w', encoding='utf-8') as f:
            f.write(text)
        self._send_json({'ok': True})

    def _wc_delete(self):
        data = self._read_json_body()
        if not data:
            self.send_error(400)
            return
        rel = data.get('path', '').strip('/')
        if not rel:
            self.send_error(400)
            return
        # Could be a file or a folder
        fp_file   = self._wc_safe(rel + '.txt')
        fp_folder = self._wc_safe(rel)
        if fp_file and os.path.isfile(fp_file):
            os.remove(fp_file)
            self._send_json({'ok': True})
        elif fp_folder and os.path.isdir(fp_folder):
            shutil.rmtree(fp_folder)
            self._send_json({'ok': True})
        else:
            self.send_error(404)

    def _wc_mkdir(self):
        data = self._read_json_body()
        if not data:
            self.send_error(400)
            return
        rel = data.get('path', '').strip('/')
        fp  = self._wc_safe(rel)
        if not fp:
            self.send_error(403)
            return
        os.makedirs(fp, exist_ok=True)
        self._send_json({'ok': True})

    def _wc_move(self):
        data = self._read_json_body()
        if not data:
            self.send_error(400)
            return
        src = self._wc_safe(data.get('from', '').strip('/') + '.txt')
        dst = self._wc_safe(data.get('to',   '').strip('/') + '.txt')
        if not src or not dst:
            self.send_error(403)
            return
        if not os.path.isfile(src):
            self.send_error(404)
            return
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        self._send_json({'ok': True})

    def _wc_resolve(self):
        data = self._read_json_body()
        if data is None:
            self.send_error(400)
            return
        prompt   = self._resolve_wildcards(data.get('prompt', ''))
        negative = self._resolve_wildcards(data.get('negative_prompt', ''))
        self._send_json({'prompt': prompt, 'negative_prompt': negative})

    def _pick_wildcard_line(self, pattern):
        """Pick a random line from wildcard file(s) matching pattern.
        Supports: name, folder/name, *, folder/*, prefix*, folder/prefix*
        """
        if not os.path.isdir(WILDCARDS_DIR):
            return None
        parts    = pattern.replace('\\', '/').strip('/').split('/')
        name_pat = parts[-1]
        base     = os.path.join(WILDCARDS_DIR, *parts[:-1]) if len(parts) > 1 else WILDCARDS_DIR

        if pattern.strip('/') == '*':
            files = _glob.glob(os.path.join(WILDCARDS_DIR, '**', '*.txt'), recursive=True)
        elif '*' in name_pat:
            files = _glob.glob(os.path.join(base, name_pat + '.txt'))
        else:
            fp = os.path.normpath(os.path.join(base, name_pat + '.txt'))
            files = [fp] if os.path.isfile(fp) else []

        valid = []
        for f in files:
            try:
                nf = os.path.normpath(f)
                if os.path.isfile(nf) and os.path.commonpath([nf, WILDCARDS_DIR]) == WILDCARDS_DIR:
                    valid.append(nf)
            except ValueError:
                pass

        if not valid:
            return None
        chosen = random.choice(valid)
        try:
            with open(chosen, 'r', encoding='utf-8') as fh:
                lines = [l.strip() for l in fh if l.strip() and not l.strip().startswith('#')]
            return random.choice(lines) if lines else None
        except Exception:
            return None

    def _resolve_wildcards(self, text, depth=0):
        """Recursively resolve __wildcard__ patterns, up to depth 10."""
        if depth > 10 or '__' not in text:
            return text

        def replacer(m):
            line = self._pick_wildcard_line(m.group(1))
            if line is None:
                return m.group(0)
            return self._resolve_wildcards(line, depth + 1)

        return re.sub(r'__(.+?)__', replacer, text)

    # ── Proxy ─────────────────────────────────────────────────────────────────

    def _proxy(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length) if length else None
        ct     = self.headers.get('Content-Type', 'application/json')

        req = urllib.request.Request(API_TARGET + self.path, data=body, method=self.command)
        if body:
            req.add_header('Content-Type', ct)

        # Generation endpoints can take arbitrarily long; progress polling needs a short timeout
        gen_paths = ('/sdapi/v1/txt2img', '/sdapi/v1/img2img')
        path_base = self.path.split('?')[0]
        timeout = None if path_base in gen_paths else 60

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', resp.headers.get('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(502, str(e))

    def _static(self, path):
        if path in ('/', ''):
            path = '/index.html'
        fp = os.path.normpath(os.path.join(DIR, path.lstrip('/')))
        if os.path.commonpath([fp, DIR]) != DIR or not os.path.isfile(fp):
            self.send_error(404)
            return
        ext = os.path.splitext(fp)[1].lower()
        ct  = MIME.get(ext, 'application/octet-stream')
        with open(fp, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    import socket
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)

    # Show all addresses this machine is reachable on
    hostname = socket.gethostname()
    try:
        lan_ip = socket.gethostbyname(hostname)
    except Exception:
        lan_ip = '(unknown)'

    print(f'SDNext UI  ->  http://localhost:{PORT}')
    print(f'             http://{lan_ip}:{PORT}  (LAN)')
    print(f'SDNext API ->  {API_TARGET}')
    print('Press Ctrl+C to stop\n')
    webbrowser.open(f'http://localhost:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('Stopped.')
