import http.server, sys, os
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin","*"); super().end_headers()
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(("127.0.0.1",8099),H).serve_forever()
