require('dotenv').config();
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const readlineSync = require('readline-sync');

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
    console.log('Archivo subido con éxito:', response.data);
    fs.unlinkSync(filePath);
    console.log('Archivo eliminado localmente:', filePath);
  } catch (error) {
    console.error('Error al subir el archivo:', error);
  }
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

(async () => {
  const almacenNombre = readlineSync.question('¿Qué almacén desea seleccionar? ').trim().toUpperCase();
  if (!almacenes[almacenNombre]) {
    console.error('Error: El almacén ingresado no coincide con ninguno de la lista. No se puede continuar.');
    process.exit(1);
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
  console.log(`Archivo descargado, renombrado a ${nombreArchivoFinal} y movido a: ${finalFilePath}`);

  // --- Subida a Google Drive ---
  fs.readdir(descargasDir, (err, files) => {
    if (err) return console.error('No se pudo leer la carpeta de descargas-admintotal:', err);
    let found = false;
    files.forEach(file => {
      const folderId = folderMap[file];
      if (folderId) {
        found = true;
        const filePath = path.join(descargasDir, file);
        if (fs.lstatSync(filePath).isFile()) uploadFile(filePath, folderId);
      }
    });
    if (!found) console.error('No se encontró ningún archivo válido para subir.');
  });
})();