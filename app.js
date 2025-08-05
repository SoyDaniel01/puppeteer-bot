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

// --- Clase para manejo de autenticación Google ---
class GoogleAuthManager {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    this.oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    this.lastRefresh = null;
  }

  async ensureValidToken() {
    try {
      // Si el token fue refrescado hace menos de 50 minutos, no hacer nada
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

// Instancia global del manejador de autenticación
const authManager = new GoogleAuthManager();

// --- Función mejorada para esperar descarga completa ---
function waitForCompleteDownload(downloadPath, filesBefore, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      try {
        const filesNow = fs.readdirSync(downloadPath);
        
        // Buscar archivos nuevos (que no estaban antes)
        const newFiles = filesNow.filter(f => !filesBefore.has(f));
        
        // Filtrar archivos .crdownload (descarga en progreso)
        const downloadingFiles = newFiles.filter(f => f.endsWith('.crdownload'));
        const completedFiles = newFiles.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
        
        console.log(`Archivos en descarga: ${downloadingFiles.length}, Archivos completos: ${completedFiles.length}`);
        
        // Si hay archivos completos, devolver el primero
        if (completedFiles.length > 0) {
          clearInterval(interval);
          const filePath = path.join(downloadPath, completedFiles[0]);
          console.log(`Descarga completa: ${completedFiles[0]}`);
          resolve(filePath);
          return;
        }
        
        // Si hay archivos .crdownload, seguir esperando
        if (downloadingFiles.length > 0) {
          console.log(`Esperando descarga completa... ${downloadingFiles[0]}`);
        }
        
        // Timeout
        if (Date.now() - start > timeout) {
          clearInterval(interval);
          
          // Intentar con archivos .crdownload si no hay otra opción
          if (downloadingFiles.length > 0) {
            console.log('Timeout alcanzado, pero hay archivo .crdownload. Intentando usarlo...');
            const crdownloadFile = path.join(downloadPath, downloadingFiles[0]);
            
            // Renombrar el archivo .crdownload para intentar usarlo
            const finalName = downloadingFiles[0].replace('.crdownload', '');
            const finalPath = path.join(downloadPath, finalName);
            
            try {
              fs.renameSync(crdownloadFile, finalPath);
              resolve(finalPath);
            } catch (renameError) {
              reject(new Error(`Timeout y error al renombrar archivo .crdownload: ${renameError.message}`));
            }
          } else {
            reject(new Error(`Timeout esperando descarga completa (${timeout}ms)`));
          }
        }
      } catch (error) {
        clearInterval(interval);
        reject(new Error(`Error verificando archivos: ${error.message}`));
      }
    }, 1000); // Verificar cada segundo
  });
}

// --- Función mejorada de upload ---
async function uploadFile(filePath, folderId) {
  try {
    console.log('Iniciando subida a Google Drive...');
    
    // Asegurar que tenemos token válido
    const oauth2Client = await authManager.ensureValidToken();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    console.log(`Subiendo archivo: ${path.basename(filePath)} a carpeta: ${folderId}`);
    
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
    console.error('Error detallado en uploadFile:', error);
    
    // Mensajes de error más específicos
    let errorMessage = error.message;
    
    if (error.code === 403) {
      errorMessage = 'Sin permisos para acceder a Google Drive. Verifica los scopes.';
    } else if (error.code === 404) {
      errorMessage = 'Carpeta de destino no encontrada en Google Drive.';
    } else if (error.message.includes('invalid_grant')) {
      errorMessage = 'Token de Google expirado. Genera un nuevo REFRESH_TOKEN.';
    } else if (error.code === 'ENOENT') {
      errorMessage = 'Archivo no encontrado para subir.';
    }
    
    return { success: false, error: errorMessage };
  }
}

// --- Función principal mejorada ---
async function ejecutarFlujo(almacenNombre) {
  almacenNombre = almacenNombre.trim().toUpperCase();
  if (!almacenes[almacenNombre]) {
    throw new Error('El almacén ingresado no coincide con ninguno de la lista.');
  }
  const { valor: almacenValor, anaquel: anaquelValor } = almacenes[almacenNombre];

  console.log(`=== INICIANDO FLUJO PARA ${almacenNombre} ===`);
  console.log(`Almacén valor: ${almacenValor}, Anaquel: ${anaquelValor}`);

  // --- Descarga con Puppeteer ---
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
  const downloadDir = path.resolve('./puppeteer-downloads');
  
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
    console.log(`Directorio de descarga creado: ${downloadDir}`);
  }
  
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { 
    behavior: 'allow', 
    downloadPath: downloadDir 
  });

  console.log('Navegando al sitio web...');
  await page.goto('https://sanbenito.admintotal.com/admin/inventario/utilerias/inventario_fisico/descarga_archivos/?task_panel=1&first=1', {
    waitUntil: 'networkidle0', 
    timeout: 60000
  });

  // Login si es necesario
  if (await page.$('input[name="username"]')) {
    console.log('Haciendo login...');
    await page.type('input[name="username"]', USER);
    await page.type('input[name="password"]', PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 30000 }),
      page.click('button[type="submit"]')
    ]);
    console.log('Login exitoso');
  }

  console.log('Configurando filtros de descarga...');
  await page.waitForSelector('input[type="checkbox"]', { timeout: 30000 });
  await page.click('input[name="usar_posicion"]');
  await page.click('input[name="con_existencia"]');
  await page.select('select[name="almacen"]', almacenValor);
  await page.type('input[name="desde_anaquel"]', anaquelValor);
  await page.type('input[name="hasta_anaquel"]', anaquelValor);
  
  console.log('Iniciando generación de archivo...');
  await page.click('a[href="javascript:enviar(\'xls\');"]');
  await page.waitForSelector('.slide-panel.process-center-wrapper.visible', { timeout: 30000 });
  
  // Esperar a que el proceso termine
  console.log('Esperando procesamiento del archivo...');
  await new Promise(r => setTimeout(r, 15000)); // Aumentar tiempo de espera

  // Verificar archivos antes de la descarga
  const before = new Set(fs.readdirSync(downloadDir));
  console.log(`Archivos antes de descarga: ${[...before].join(', ')}`);

  console.log('Iniciando descarga...');
  await page.evaluate(() => {
    const item = document.querySelector('.slide-panel.process-center-wrapper.visible .content ul li');
    if (item) {
      const downloadLink = item.querySelector('a[href^="/admin/procesos/descargar_archivo/"]');
      if (downloadLink) {
        downloadLink.click();
        console.log('Click en enlace de descarga ejecutado');
      } else {
        throw new Error('No se encontró el enlace de descarga');
      }
    } else {
      throw new Error('No se encontró el elemento de descarga');
    }
  });

  // Usar la función mejorada de espera
  console.log('Esperando que la descarga termine...');
  const downloadedFile = await waitForCompleteDownload(downloadDir, before, 120000); // 2 minutos
  
  await browser.close();
  console.log(`Archivo descargado: ${downloadedFile}`);

  // Renombrar y mover a descargas-admintotal
  const descargasDir = path.resolve('./descargas-admintotal');
  if (!fs.existsSync(descargasDir)) {
    fs.mkdirSync(descargasDir, { recursive: true });
    console.log(`Directorio final creado: ${descargasDir}`);
  }
  
  const nombreArchivoFinal = almacenNombre + '.xlsx';
  const finalFilePath = path.join(descargasDir, nombreArchivoFinal);
  
  console.log(`Moviendo archivo de ${downloadedFile} a ${finalFilePath}`);
  fs.renameSync(downloadedFile, finalFilePath);

  // --- Subida a Google Drive ---
  console.log('Iniciando subida a Google Drive...');
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
  
  console.log('¡Flujo completado exitosamente!');
  return { 
    status: 'ok', 
    uploaded: nombreArchivoFinal, 
    driveResponse: result.data,
    message: `Archivo ${nombreArchivoFinal} procesado y subido exitosamente`
  };
}

// --- Middleware ---
app.use(express.json());

// --- Endpoints ---

// Endpoint principal
app.post('/trigger', async (req, res) => {
  console.log('=== INICIO DE PETICIÓN ===');
  const almacenNombre = req.body.almacen;
  console.log('Almacén recibido:', almacenNombre);
  
  if (!almacenNombre) {
    console.log('ERROR: Falta el nombre del almacén');
    return res.status(400).json({ error: 'Falta el nombre del almacén' });
  }
  
  try {
    console.log('=== VERIFICANDO VARIABLES DE ENTORNO ===');
    console.log('CLIENT_ID configurado:', !!process.env.CLIENT_ID);
    console.log('CLIENT_SECRET configurado:', !!process.env.CLIENT_SECRET);
    console.log('USER_LOGIN configurado:', !!process.env.USER_LOGIN);
    console.log('USER_PASS configurado:', !!process.env.USER_PASS);
    
    console.log('=== INICIANDO FLUJO ===');
    const result = await ejecutarFlujo(almacenNombre);
    console.log('Flujo completado exitosamente:', result);
    res.json(result);
  } catch (err) {
    console.log('=== ERROR EN EL FLUJO ===');
    console.error('Error completo:', err);
    console.error('Stack trace:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint de salud básico
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

// Endpoint de diagnóstico de Google Drive
app.get('/health-drive', async (req, res) => {
  try {
    console.log('Verificando conexión con Google Drive...');
    
    const oauth2Client = await authManager.ensureValidToken();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    // Hacer una consulta simple para mantener el token activo
    const response = await drive.about.get({ 
      fields: 'user(emailAddress), storageQuota(usage,limit)' 
    });
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      googleDrive: {
        connected: true,
        userEmail: response.data.user.emailAddress,
        storageUsed: response.data.storageQuota.usage,
        storageLimit: response.data.storageQuota.limit,
        lastTokenRefresh: authManager.lastRefresh ? new Date(authManager.lastRefresh).toISOString() : 'never'
      }
    });
    
  } catch (error) {
    console.error('Error en health-drive:', error);
    
    let errorDetails = {
      message: error.message,
      needsNewRefreshToken: error.message.includes('invalid_grant')
    };
    
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      googleDrive: {
        connected: false,
        error: errorDetails
      }
    });
  }
});

// Endpoint para probar Puppeteer
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

// Endpoint de diagnóstico detallado de Google Drive
app.get('/test-google-drive', async (req, res) => {
  console.log('=== DIAGNÓSTICO GOOGLE DRIVE ===');
  
  try {
    // Mostrar configuración (sin revelar secretos completos)
    console.log('CLIENT_ID:', process.env.CLIENT_ID ? `${process.env.CLIENT_ID.substring(0, 10)}...` : 'NO DEFINIDO');
    console.log('CLIENT_SECRET:', process.env.CLIENT_SECRET ? `${process.env.CLIENT_SECRET.substring(0, 10)}...` : 'NO DEFINIDO');
    console.log('REDIRECT_URI:', process.env.REDIRECT_URI);
    console.log('REFRESH_TOKEN:', process.env.REFRESH_TOKEN ? `${process.env.REFRESH_TOKEN.substring(0, 10)}...` : 'NO DEFINIDO');
    
    // Crear cliente OAuth
    const oauth2Client = await authManager.ensureValidToken();
    console.log('Cliente OAuth creado y token validado');
    
    // Probar conexión con Drive
    console.log('Probando conexión con Google Drive...');
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    const aboutResponse = await drive.about.get({ 
      fields: 'user(emailAddress), storageQuota(usage)' 
    });
    
    console.log('Respuesta de Google Drive:', aboutResponse.data);
    
    res.json({
      success: true,
      message: 'Google Drive conectado correctamente',
      userEmail: aboutResponse.data.user.emailAddress,
      storageUsed: aboutResponse.data.storageQuota.usage,
      lastTokenRefresh: authManager.lastRefresh ? new Date(authManager.lastRefresh).toISOString() : 'never'
    });
    
  } catch (error) {
    console.error('=== ERROR EN DIAGNÓSTICO ===');
    console.error('Error completo:', error);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    
    res.status(500).json({
      success: false,
      error: error.message,
      errorCode: error.code,
      errorDetails: {
        isInvalidGrant: error.message.includes('invalid_grant'),
        isInvalidClient: error.message.includes('invalid_client'),
        isAccessDenied: error.message.includes('access_denied'),
        fullError: error.toString()
      }
    });
  }
});

// Keep alive endpoint
app.get('/keep-alive', async (req, res) => {
  try {
    const authClient = await authManager.ensureValidToken();
    res.json({
      message: 'Keep alive ejecutado',
      tokenRefreshed: !!authManager.lastRefresh,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      message: 'Error en keep alive',
      error: error.message
    });
  }
});

// Endpoint principal
app.get('/', (req, res) => {
  res.send('API de automatización de descarga y subida a Google Drive está corriendo.');
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});