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

PORT = 8080
API_TARGET = 'http://localhost:7860'
DIR = os.path.dirname(os.path.abspath(__file__))

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
        params = self._png_text(fp).get('parameters', '')
        resp   = json.dumps({'parameters': params}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def _png_text(self, filepath):
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
                    elif ctype == 'IDAT':
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

    def _proxy(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length) if length else None
        ct     = self.headers.get('Content-Type', 'application/json')

        req = urllib.request.Request(API_TARGET + self.path, data=body, method=self.command)
        if body:
            req.add_header('Content-Type', ct)

        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
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
