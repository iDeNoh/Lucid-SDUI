"""
SDNext UI proxy server
- Serves index.html / style.css / app.js on http://localhost:8080
- Forwards all /sdapi/ requests to SDNext at http://localhost:7860
  so the browser sees everything as same-origin (no CORS issues)
"""
import http.server
import urllib.request
import urllib.error
import os
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
        else:
            self._static(path)

    def do_POST(self):
        if self.path.startswith('/sdapi/'):
            self._proxy()
        else:
            self.send_error(405)

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
