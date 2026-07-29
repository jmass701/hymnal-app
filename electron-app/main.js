const { app, BrowserWindow } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ico': 'image/x-icon'
};

function startServer(root, port) {
  http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(root, urlPath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(port, '127.0.0.1');
}

// --- Scan2Notes (Audiveris OMR) background server -----------------------
// Bundled alongside the app so "Edit Tune" can auto-scan sheet music
// without the user separately starting a server by hand. Still requires
// Audiveris (and optionally Ghostscript) installed on this machine, with
// AUDIVERIS_HOME / GHOSTSCRIPT_HOME set -- this just removes the need to
// run start.bat every time.
let scanServerProcess = null;

function scanServerEntryPath() {
  if (app.isPackaged) {
    // electron-builder unpacks anything matched by "asarUnpack" to a
    // sibling folder next to app.asar, under resources/.
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'scan2notes-server', 'server.js');
  }
  return path.join(__dirname, 'scan2notes-server', 'server.js');
}

function startScanServer() {
  const serverPath = scanServerEntryPath();
  if (!fs.existsSync(serverPath)) {
    console.warn('Scan2Notes server not found at', serverPath, '-- Edit Tune auto-scan will be unavailable.');
    return;
  }
  try {
    scanServerProcess = fork(serverPath, [], {
      cwd: path.dirname(serverPath),
      env: Object.assign({}, process.env, { PORT: '3000' }),
      stdio: 'ignore'
    });
    scanServerProcess.on('error', (err) => {
      console.error('Scan2Notes server failed to start:', err);
    });
    scanServerProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn('Scan2Notes server exited with code', code, '(port 3000 may already be in use by another instance, which is fine)');
      }
      scanServerProcess = null;
    });
  } catch (err) {
    console.error('Could not launch Scan2Notes server:', err);
  }
}

function stopScanServer() {
  if (scanServerProcess) {
    scanServerProcess.kill();
    scanServerProcess = null;
  }
}

function createWindow() {
  const port = 47821;
  startServer(path.join(__dirname, 'app'), port);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'app', 'icon-512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(() => {
  startScanServer();
  createWindow();
});

app.on('before-quit', stopScanServer);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
