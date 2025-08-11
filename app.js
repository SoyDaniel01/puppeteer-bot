require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuración ---
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  REFRESH_TOKEN,
  USER_LOGIN: USER,
  USER_PASS: PASS,
  DEBUG_MODE
} = process.env;

const debugLog = (message) => {
  if (DEBUG_MODE === 'true') console.log(message);
};

const folderMap = {
  'MATRIZ.xlsx': '1LEQOlRDyZnZ7IbhxMS5CP44IOAOVBbj7',
  'MINITAS.xlsx': '1mjqmTiYdYSk55GpWUq0LWxmHb2Tt5uRk',
  'PERINORTE.xlsx': '1RT5qL8XG6zaaJgrI6M2jm3KRg7gJr-hp',
  'SAHUARO.xlsx': '1mQJb1PNZWAs8ptSPWDh2JO2aGbCRDNlK',
  'SANMARCOS.xlsx': '1VgOTpPbED6du75QVCHVh17VolFMOsS0o',
};

const almacenes = {
  MATRIZ: { valor: '9', anaquel: 'DIARIOMTZ' },
  PERINORTE: { valor: '19171', anaquel: 'DIARIOPN' },
  SANMARCOS: { valor: '188746', anaquel: 'DIARIOSM' },
  SAHUARO: { valor: '203738', anaquel: 'DIARIOSH' },
  MINITAS: { valor: '203740', anaquel: 'DIARIOMN' },
};

// --- Google Auth Manager ---
class GoogleAuthManager {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    this.oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    this.lastRefresh = null;
  }

  async ensureValidToken() {
    try {
      if (this.lastRefresh && (Date.now() - this.lastRefresh) < 50 * 60 * 1000) {
        return this.oauth2Client;
      }

      console.log('Refrescando access token...');
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.oauth2Client.setCredentials(credentials);
      this.lastRefresh = Date.now();
      console.log('Token refrescado exitosamente');
      return this.oauth2Client;
    } catch (error) {
      console.error('Error refrescando token:', error.message);
      if (error.message.includes('invalid_grant')) {
        throw new Error('REFRESH_TOKEN inválido o expirado. Necesitas generar uno nuevo.');
      }
      throw error;
    }
  }
}

const authManager = new GoogleAuthManager();

// --- Utilidades ---
const waitForDownload = (downloadPath, filesBefore, timeout = 120000) => {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      try {
        const filesNow = fs.readdirSync(downloadPath);
        const newFiles = filesNow.filter(f => !filesBefore.has(f));
        const downloadingFiles = newFiles.filter(f => f.endsWith('.crdownload'));
        const completedFiles = newFiles.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));

        console.log(`Descargando: ${downloadingFiles.length}, Completos: ${completedFiles.length}`);

        if (completedFiles.length > 0) {
          clearInterval(interval);
          const filePath = path.join(downloadPath, completedFiles[0]);
          console.log(`Descarga completa: ${completedFiles[0]}`);
          resolve(filePath);
          return;
        }

        if (Date.now() - start > timeout) {
          clearInterval(interval);
          if (downloadingFiles.length > 0) {
            console.log('Timeout alcanzado, intentando usar archivo .crdownload...');
            const crdownloadFile = path.join(downloadPath, downloadingFiles[0]);
            const finalName = downloadingFiles[0].replace('.crdownload', '');
            const finalPath = path.join(downloadPath, finalName);

            try {
              fs.renameSync(crdownloadFile, finalPath);
              resolve(finalPath);
            } catch (renameError) {
              reject(new Error(`Error al renombrar archivo: ${renameError.message}`));
            }
          } else {
            reject(new Error(`Timeout esperando descarga (${timeout}ms)`));
          }
        }
      } catch (error) {
        clearInterval(interval);
        reject(new Error(`Error verificando archivos: ${error.message}`));
      }
    }, 1000);
  });
};

const uploadFile = async (filePath, folderId) => {
  try {
    console.log('Subiendo archivo a Google Drive...');
    const oauth2Client = await authManager.ensureValidToken();
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

    console.log('Archivo subido exitosamente:', response.data.id);
    fs.unlinkSync(filePath);
    return { success: true, data: response.data };
  } catch (error) {
    console.error('Error en uploadFile:', error);
    let errorMessage = error.message;

    if (error.code === 403) errorMessage = 'Sin permisos para Google Drive. Verifica los scopes.';
    else if (error.code === 404) errorMessage = 'Carpeta de destino no encontrada.';
    else if (error.message.includes('invalid_grant')) errorMessage = 'Token de Google expirado.';
    else if (error.code === 'ENOENT') errorMessage = 'Archivo no encontrado.';

    return { success: false, error: errorMessage };
  }
};

// --- Función principal ---
async function ejecutarFlujo(almacenNombre) {
  almacenNombre = almacenNombre.trim().toUpperCase();
  
  if (!almacenes[almacenNombre]) {
    throw new Error('Almacén no válido');
  }

  const { valor: almacenValor, anaquel: anaquelValor } = almacenes[almacenNombre];
  console.log(`Ejecutando flujo para ${almacenNombre} (${almacenValor}, ${anaquelValor})`);

  // Setup de directorios
  const downloadDir = path.resolve('./puppeteer-downloads');
  const descargasDir = path.resolve('./descargas-admintotal');
  
  [downloadDir, descargasDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Directorio creado: ${dir}`);
    }
  });

  const filesBefore = new Set(fs.readdirSync(downloadDir));

  // Puppeteer
  const browser = await puppeteer.launch({
    headless: true,
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security'
    ]
  });

  try {
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir
    });

    // Navegación y login
    console.log('Navegando al sitio...');
    await page.goto('https://sanbenito.admintotal.com/admin/inventario/utilerias/inventario_fisico/descarga_archivos/?task_panel=1&first=1', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    if (await page.$('input[name="username"]')) {
      console.log('Haciendo login...');
      await page.type('input[name="username"]', USER);
      await page.type('input[name="password"]', PASS);
      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }),
        page.click('button[type="submit"]')
      ]);
      await new Promise(r => setTimeout(r, 3000));
    }

    // Configuración de filtros
    console.log('Configurando filtros...');
    await page.waitForSelector('input[type="checkbox"]', { timeout: 30000 });

    // Configurar checkboxes
    await page.$eval('input[name="usar_posicion"]', el => { if (el.checked) el.click(); });
    await page.$eval('input[name="con_existencia"]', el => { if (el.checked) el.click(); });
    await page.$eval('input[name="mostrar_existencias"]', el => { if (!el.checked) el.click(); });

    // Configurar almacén
    await page.select('select[name="almacen"]', almacenValor);

    // Configurar anaqueles
    await page.evaluate((valor) => {
      const inputs = ['desde_anaquel', 'hasta_anaquel'];
      inputs.forEach(name => {
        const input = document.querySelector(`input[name="${name}"]`);
        if (input) {
          input.value = valor;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }, anaquelValor);

    await new Promise(r => setTimeout(r, 2000));

    // Generar archivo
    console.log('Generando archivo...');
    await page.click('a[href="javascript:enviar(\'xls\');"]');
    await new Promise(r => setTimeout(r, 5000));
    await page.click('a[href="javascript:enviar(\'xls\');"]');

    // Buscar enlace de descarga
    console.log('Buscando enlace de descarga...');
    let downloadFound = false;
    const maxAttempts = 15;

    for (let attempt = 1; attempt <= maxAttempts && !downloadFound; attempt++) {
      console.log(`Búsqueda ${attempt}/${maxAttempts}...`);

      try {
        const downloadLink = await page.$('a[href*="descargar"]');
        if (downloadLink) {
          console.log('Enlace encontrado, descargando...');
          await downloadLink.click();
          downloadFound = true;
        } else {
          await new Promise(r => setTimeout(r, 3000));
        }
      } catch (error) {
        debugLog(`Error en búsqueda ${attempt}: ${error.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (!downloadFound) {
      throw new Error('No se pudo encontrar el enlace de descarga');
    }

    // Esperar descarga
    console.log('Esperando descarga...');
    const downloadedFile = await waitForDownload(downloadDir, filesBefore);

    // Mover archivo
    const nombreArchivoFinal = `${almacenNombre}.xlsx`;
    const finalFilePath = path.join(descargasDir, nombreArchivoFinal);
    fs.renameSync(downloadedFile, finalFilePath);
    console.log(`Archivo movido a: ${finalFilePath}`);

    // Procesar Excel
    let tabla = [];
    try {
      console.log('Procesando archivo Excel...');
      const workbook = xlsx.readFile(finalFilePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

      // Extraer columnas G (6) y N (13)
      for (let i = 1; i < data.length; i++) {
        tabla.push({
          posicion: data[i][6],
          existencia: data[i][13]
        });
      }
      console.log(`Extraídos ${tabla.length} registros`);
    } catch (error) {
      console.error('Error procesando Excel:', error.message);
    }

    // Subir a Google Drive
    console.log('Subiendo a Google Drive...');
    const folderId = folderMap[nombreArchivoFinal];
    if (!folderId) {
      throw new Error('No se encontró carpeta de destino para este archivo');
    }

    const uploadResult = await uploadFile(finalFilePath, folderId);
    if (!uploadResult.success) {
      throw new Error(`Error al subir: ${uploadResult.error}`);
    }

    console.log('Flujo completado exitosamente');
    return {
      status: 'ok',
      uploaded: nombreArchivoFinal,
      driveResponse: uploadResult.data,
      tabla
    };

  } finally {
    await browser.close();
  }
}

// --- Middleware ---
app.use(express.json());

// --- Endpoints ---
app.post('/trigger', async (req, res) => {
  const almacenNombre = req.body.almacen;

  if (!almacenNombre) {
    return res.status(400).json({ status: 'error', message: 'Falta el nombre del almacén' });
  }

  try {
    const result = await ejecutarFlujo(almacenNombre);
    res.json(result.tabla);
  } catch (error) {
    console.error('Error en el flujo:', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    hasCredentials: {
      clientId: !!CLIENT_ID,
      clientSecret: !!CLIENT_SECRET,
      userLogin: !!USER,
      userPass: !!PASS,
      refreshToken: !!REFRESH_TOKEN
    }
  });
});

app.get('/health-drive', async (req, res) => {
  try {
    const oauth2Client = await authManager.ensureValidToken();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const response = await drive.about.get({ fields: 'user(emailAddress)' });

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      googleDrive: {
        connected: true,
        userEmail: response.data.user.emailAddress,
        lastTokenRefresh: authManager.lastRefresh ? new Date(authManager.lastRefresh).toISOString() : 'never'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      googleDrive: {
        connected: false,
        error: error.message,
        needsNewRefreshToken: error.message.includes('invalid_grant')
      }
    });
  }
});

app.get('/keep-alive', async (req, res) => {
  try {
    await authManager.ensureValidToken();
    res.json({
      message: 'Keep alive ejecutado',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      message: 'Error en keep alive',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.send('API de automatización funcionando correctamente');
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);
});