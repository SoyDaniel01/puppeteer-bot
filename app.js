require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// --- Configuración ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const USER = process.env.USER_LOGIN;
const PASS = process.env.USER_PASS;

const folderMap = {
  'MATRIZ.xlsx': '1LEQOlRDyZnZ7IbhxMS5CP44IOAOVBbj7',
  'MINITAS.xlsx': '1mjqmTiYdYSk55GpWUq0LWxmHb2Tt5uRk',
  'PERINORTE.xlsx': '1RT5qL8XG6zaaJgrI6M2jm3KRg7gJr-hp',
  'SAHUARO.xlsx': '1mQJb1PNZWAs8ptSPWDh2JO2aGbCRDNlK',
  'SANMARCOS.xlsx': '1VgOTpPbED6du75QVCHVh17VolFMOsS0o',
};

const almacenes = {
  MATRIZ:    { valor: '9',      anaquel: 'DIARIOMTZ' },
  PERINORTE: { valor: '19171',  anaquel: 'DIARIOPN' },
  SANMARCOS: { valor: '188746', anaquel: 'DIARIOSM' },
  SAHUARO:   { valor: '203738', anaquel: 'DIARIOSH' },
  MINITAS:   { valor: '203740', anaquel: 'DIARIOMN' },
};

function waitForNewFile(downloadPath, filesBefore, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const filesNow = new Set(fs.readdirSync(downloadPath));
      const newFiles = [...filesNow].filter(f => !filesBefore.has(f));
      if (newFiles.length > 0) {
        clearInterval(interval);
        resolve(path.join(downloadPath, newFiles[0]));
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error('Timeout esperando nuevo archivo'));
      }
    }, 500);
  });
}

async function uploadFile(filePath, folderId) {
  try {
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
        const response = await drive.files.create({
            requestBody: {
        name: path.basename(filePath),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        parents: [folderId],
            },
            media: {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                body: fs.createReadStream(filePath),
            },
        });
    fs.unlinkSync(filePath);
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function ejecutarFlujo(almacenNombre) {
  almacenNombre = almacenNombre.trim().toUpperCase();
  if (!almacenes[almacenNombre]) {
    throw new Error('El almacén ingresado no coincide con ninguno de la lista.');
  }
  const { valor: almacenValor, anaquel: anaquelValor } = almacenes[almacenNombre];

  // --- Descarga con Puppeteer ---
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const downloadDir = path.resolve('./puppeteer-downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  await page.goto('https://sanbenito.admintotal.com/admin/inventario/utilerias/inventario_fisico/descarga_archivos/?task_panel=1&first=1', {
    waitUntil: 'networkidle0', timeout: 60000
  });

  if (await page.$('input[name="username"]')) {
    await page.type('input[name="username"]', USER);
    await page.type('input[name="password"]', PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 30000 }),
      page.click('button[type="submit"]')
    ]);
  }

  await page.waitForSelector('input[type="checkbox"]', { timeout: 30000 });
  await page.click('input[name="usar_posicion"]');
  await page.click('input[name="con_existencia"]');
  await page.select('select[name="almacen"]', almacenValor);
  await page.type('input[name="desde_anaquel"]', anaquelValor);
  await page.type('input[name="hasta_anaquel"]', anaquelValor);
  await page.click('a[href="javascript:enviar(\'xls\');"]');
  await page.waitForSelector('.slide-panel.process-center-wrapper.visible', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 10000));

  const before = new Set(fs.readdirSync(downloadDir));
  await page.evaluate(() => {
    const item = document.querySelector('.slide-panel.process-center-wrapper.visible .content ul li');
    if (item) item.querySelector('a[href^="/admin/procesos/descargar_archivo/"]').click();
  });

  const downloadedFile = await waitForNewFile(downloadDir, before);
  await browser.close();

  // Renombrar y mover a descargas-admintotal
  const descargasDir = path.resolve('./descargas-admintotal');
  if (!fs.existsSync(descargasDir)) fs.mkdirSync(descargasDir, { recursive: true });
  const nombreArchivoFinal = almacenNombre + '.xlsx';
  const finalFilePath = path.join(descargasDir, nombreArchivoFinal);
  fs.renameSync(downloadedFile, finalFilePath);

  // --- Subida a Google Drive ---
  let found = false;
  let result = null;
  if (folderMap[nombreArchivoFinal]) {
    found = true;
    result = await uploadFile(finalFilePath, folderMap[nombreArchivoFinal]);
  }
  if (!found) {
    throw new Error('No se encontró ningún archivo válido para subir.');
  }
  if (!result.success) {
    throw new Error('Error al subir el archivo: ' + result.error);
    }
  return { status: 'ok', uploaded: nombreArchivoFinal, driveResponse: result.data };
}

app.use(express.json());

app.post('/trigger', async (req, res) => {
  const almacenNombre = req.body.almacen;
  if (!almacenNombre) {
    return res.status(400).json({ error: 'Falta el nombre del almacén' });
  }
  try {
    const result = await ejecutarFlujo(almacenNombre);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('API de automatización de descarga y subida a Google Drive está corriendo.');
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

// Añade este endpoint a tu app.js para diagnóstico
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    hasClientId: !!process.env.CLIENT_ID,
    hasClientSecret: !!process.env.CLIENT_SECRET,
    hasUserLogin: !!process.env.USER_LOGIN,
    hasUserPass: !!process.env.USER_PASS,
    hasRefreshToken: !!process.env.REFRESH_TOKEN,
    puppeteerVersion: require('puppeteer/package.json').version
  });
});

// Endpoint simplificado para probar Puppeteer
app.post('/test-puppeteer', async (req, res) => {
  try {
    console.log('Probando Puppeteer...');
    const browser = await puppeteer.launch({ 
      headless: true, 
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ] 
    });
    
    const page = await browser.newPage();
    await page.goto('https://example.com', { timeout: 10000 });
    const title = await page.title();
    await browser.close();
    
    res.json({ success: true, title, message: 'Puppeteer funciona correctamente' });
  } catch (error) {
    console.error('Error en Puppeteer:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});