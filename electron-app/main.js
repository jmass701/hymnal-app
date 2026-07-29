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

// --- Diagnostic log file --------------------------------------------------
// Packaged Electron apps have no visible console, so write a plain text
// log next to the user's data folder that can be opened in Notepad to
// see what actually happened with the bundled Scan2Notes server.
const logPath = path.join(app.getPath('userData'), 'scan2notes-debug.log');

function log(line) {
  const stamped = '[' + new Date().toISOString() + '] ' + line + '\n';
  try {
    fs.appendFileSync(logPath, stamped);
  } catch (e) {
    // best effort only
  }
}

log('--- Hymnal App starting, isPackaged=' + app.isPackaged + ' ---');
log('resourcesPath: ' + process.resourcesPath);
log('__dirname: ' + __dirname);

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
  log('Looking for Scan2Notes server at: ' + serverPath);
  log('Exists: ' + fs.existsSync(serverPath));

  if (!fs.existsSync(serverPath)) {
    log('Scan2Notes server file not found -- auto-scan will be unavailable.');
    // Log what IS actually in the resources folder, to see if bundling
    // put things somewhere unexpected.
    try {
      const resDir = process.resourcesPath;
      log('Contents of resourcesPath: ' + JSON.stringify(fs.readdirSync(resDir)));
      const unpackedDir = path.join(resDir, 'app.asar.unpacked');
      if (fs.existsSync(unpackedDir)) {
        log('Contents of app.asar.unpacked: ' + JSON.stringify(fs.readdirSync(unpackedDir)));
      } else {
        log('app.asar.unpacked directory does not exist at all.');
      }
    } catch (e) {
      log('Error inspecting resources directory: ' + e.message);
    }
    return;
  }

  try {
    scanServerProcess = fork(serverPath, [], {
      cwd: path.dirname(serverPath),
      env: Object.assign({}, process.env, { PORT: '3000' }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    scanServerProcess.stdout.on('data', (data) => log('[scan2notes stdout] ' + data.toString().trim()));
    scanServerProcess.stderr.on('data', (data) => log('[scan2notes stderr] ' + data.toString().trim()));

    scanServerProcess.on('error', (err) => {
      log('Scan2Notes server failed to start (spawn error): ' + err.message);
    });
    scanServerProcess.on('exit', (code, signal) => {
      log('Scan2Notes server exited. code=' + code + ' signal=' + signal);
      scanServerProcess = null;
    });

    log('Scan2Notes server fork() called, pid=' + (scanServerProcess.pid || 'unknown'));
  } catch (err) {
    log('Could not launch Scan2Notes server (exception): ' + err.message);
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
