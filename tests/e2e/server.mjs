import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] || 8765);
const types = { ".html": "text/html", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4", ".js": "text/javascript" };
function sendFile(req, res, file, type) {
  const stat = fs.statSync(file);
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // Extension-less endpoints identified only by Content-Type
  if (u.pathname === "/stream") return sendFile(req, res, path.join(root, "hls/master.txt"), "application/vnd.apple.mpegurl");
  if (u.pathname === "/media/file") return sendFile(req, res, path.join(root, "sample.mp4"), "video/mp4");
  const file = path.join(root, path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  sendFile(req, res, file, types[path.extname(file)] || "application/octet-stream");
}).listen(port, "127.0.0.1", () => console.log("listening", port));
