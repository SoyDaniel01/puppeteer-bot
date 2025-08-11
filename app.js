require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');

// --- Configuración ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const USER = process.env.USER_LOGIN;
const PASS = process.env.USER_PASS;
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// Helper para logs condicionales
const debugLog = (message) => {
  if (DEBUG_MODE) console.log(message);
};

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

// --- Utilidad para esperar descarga completa ---
const waitForCompleteDownload = (downloadPath, filesBefore, timeout = 120000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const interval = setInterval(() => {
    try {
      const filesNow = fs.readdirSync(downloadPath);
      
      // Buscar archivos nuevos (que no estaban antes)
      const newFiles = filesNow.filter(f => !filesBefore.has(f));
      
      // Filtrar archivos .crdownload (descarga en progreso)
      const downloadingFiles = newFiles.filter(f => f.endsWith('.crdownload'));
      const completedFiles = newFiles.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      
      console.log(`📁 Archivos en descarga: ${downloadingFiles.length}, ✅ Completos: ${completedFiles.length}`);
      console.log(`🔍 Archivos nuevos encontrados: ${newFiles.join(', ') || 'ninguno'}`);
      console.log(`📂 Total archivos en directorio: ${filesNow.length}`);
      
      // Si hay archivos completos, devolver el primero
      if (completedFiles.length > 0) {
        clearInterval(interval);
        const filePath = path.join(downloadPath, completedFiles[0]);
        console.log(`✅ Descarga completa: ${completedFiles[0]}`);
        resolve(filePath);
        return;
      }
      
      // Si hay archivos .crdownload, seguir esperando (solo log cada 10 segundos)
      if (downloadingFiles.length > 0 && (Date.now() - start) % 10000 < 1000) {
        console.log(`⏳ Esperando descarga: ${downloadingFiles[0]}`);
      }
      
      // Timeout
      if (Date.now() - start > timeout) {
        clearInterval(interval);
        
        // Intentar con archivos .crdownload si no hay otra opción
        if (downloadingFiles.length > 0) {
          console.log('⚠️ Timeout alcanzado, intentando usar archivo .crdownload...');
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

// --- Utilidad para subir archivo a Google Drive ---
const uploadFile = async (filePath, folderId) => {
  try {
    console.log('Iniciando subida a Google Drive...');
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
};

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
  console.log('🚀 Iniciando Puppeteer...');
  
  let browser;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    try {
      browser = await puppeteer.launch({ 
        headless: true, // Activar headless para producción
        timeout: 60000, // Aumentar timeout a 60 segundos
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--memory-pressure-off',
          '--max_old_space_size=4096'
        ]
      });
      console.log('✅ Puppeteer iniciado exitosamente');
      break;
    } catch (error) {
      retryCount++;
      console.log(`❌ Intento ${retryCount}/${maxRetries} falló:`, error.message);
      
      if (retryCount >= maxRetries) {
        throw new Error(`Puppeteer no pudo iniciar después de ${maxRetries} intentos: ${error.message}`);
      }
      
      console.log('🔄 Reintentando en 5 segundos...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
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
    await new Promise(r => setTimeout(r, 5000)); // Espera 5 segundos después del login
  }

  console.log('Configurando filtros de descarga...');
  await page.waitForSelector('input[type="checkbox"]', { timeout: 30000 });
  
  // Debugging: verificar que los elementos existan antes de interactuar
  console.log('🔍 Verificando elementos de filtros...');
  const filterElements = await page.evaluate(() => {
    const almacenSelect = document.querySelector('select[name="almacen"]');
    const desdeInput = document.querySelector('input[name="desde_anaquel"]');
    const hastaInput = document.querySelector('input[name="hasta_anaquel"]');
    
    return {
      almacenSelect: {
        exists: !!almacenSelect,
        value: almacenSelect ? almacenSelect.value : null,
        options: almacenSelect ? almacenSelect.options.length : 0,
        visible: almacenSelect ? almacenSelect.offsetParent !== null : false
      },
      desdeInput: {
        exists: !!desdeInput,
        value: desdeInput ? desdeInput.value : null,
        visible: desdeInput ? desdeInput.offsetParent !== null : false,
        disabled: desdeInput ? desdeInput.disabled : null
      },
      hastaInput: {
        exists: !!hastaInput,
        value: hastaInput ? hastaInput.value : null,
        visible: hastaInput ? hastaInput.offsetParent !== null : false,
        disabled: hastaInput ? hastaInput.disabled : null
      }
    };
  });
  
  console.log('📊 Estado de elementos de filtros:', filterElements);
  
  // Asegurar que 'usar_posicion' esté desactivado
  console.log('🔧 Configurando checkbox usar_posicion...');
  await page.$eval('input[name="usar_posicion"]', el => { if (el.checked) el.click(); });
  console.log('✅ Checkbox usar_posicion configurado');
  
  // Asegurar que 'con_existencia' esté desactivado
  console.log('🔧 Configurando checkbox con_existencia...');
  await page.$eval('input[name="con_existencia"]', el => { if (el.checked) el.click(); });
  console.log('✅ Checkbox con_existencia configurado');
  
  // Asegurar que 'mostrar_existencias' esté activado
  console.log('🔧 Configurando checkbox mostrar_existencias...');
  await page.$eval('input[name="mostrar_existencias"]', el => { if (!el.checked) el.click(); });
  console.log('✅ Checkbox mostrar_existencias configurado');
  
  // Configurar almacén
  console.log(`🔧 Seleccionando almacén: ${almacenValor}`);
  try {
    await page.select('select[name="almacen"]', almacenValor);
    console.log('✅ Almacén seleccionado exitosamente');
  } catch (error) {
    console.log('❌ Error seleccionando almacén:', error.message);
  }
  
  // Configurar campos de anaquel
  console.log(`🔧 Configurando desde_anaquel: ${anaquelValor}`);
  try {
    // Usar JavaScript directo para configurar el valor
    await page.evaluate((valor) => {
      const input = document.querySelector('input[name="desde_anaquel"]');
      if (input) {
        input.value = valor;
        // Disparar eventos para que la página reconozca el cambio
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        console.log('Campo desde_anaquel configurado con valor:', valor);
      }
    }, anaquelValor);
    console.log('✅ Campo desde_anaquel configurado');
  } catch (error) {
    console.log('❌ Error configurando desde_anaquel:', error.message);
  }
  
  console.log(`🔧 Configurando hasta_anaquel: ${anaquelValor}`);
  try {
    // Usar JavaScript directo para configurar el valor
    await page.evaluate((valor) => {
      const input = document.querySelector('input[name="hasta_anaquel"]');
      if (input) {
        input.value = valor;
        // Disparar eventos para que la página reconozca el cambio
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        console.log('Campo hasta_anaquel configurado con valor:', valor);
      }
    }, anaquelValor);
    console.log('✅ Campo hasta_anaquel configurado');
  } catch (error) {
    console.log('❌ Error configurando hasta_anaquel:', error.message);
  }
  
  // Esperar un poco para que los valores se estabilicen
  console.log('⏳ Esperando que los valores de los campos se estabilicen...');
  await new Promise(r => setTimeout(r, 3000));
  
  // Verificar si los valores se mantuvieron
  console.log('🔍 Verificando si los valores se mantuvieron...');
  const intermediateState = await page.evaluate(() => {
    const desdeInput = document.querySelector('input[name="desde_anaquel"]');
    const hastaInput = document.querySelector('input[name="hasta_anaquel"]');
    
    // Debugging adicional: verificar si hay algún script interfiriendo
    const desdeEvents = desdeInput ? desdeInput.getEventListeners : 'No disponible';
    const hastaEvents = hastaInput ? hastaInput.getEventListeners : 'No disponible';
    
    return {
      desde_anaquel: desdeInput ? desdeInput.value : null,
      hasta_anaquel: hastaInput ? hastaInput.value : null,
      desde_events: desdeEvents,
      hasta_events: hastaEvents,
      desde_readonly: desdeInput ? desdeInput.readOnly : null,
      hasta_readonly: hastaInput ? hastaInput.readOnly : null
    };
  });
  
  console.log('📊 Estado intermedio de los campos:', intermediateState);
  
  // Si los valores se perdieron, intentar configurarlos nuevamente con método más agresivo
  if (!intermediateState.desde_anaquel || !intermediateState.hasta_anaquel) {
    console.log('⚠️ Los valores se perdieron, intentando configurarlos nuevamente con método más agresivo...');
    
    if (!intermediateState.desde_anaquel) {
      console.log('🔄 Reconfigurando desde_anaquel con método agresivo...');
      await page.evaluate((valor) => {
        const input = document.querySelector('input[name="desde_anaquel"]');
        if (input) {
          // Limpiar el campo primero
          input.value = '';
          // Establecer el nuevo valor
          input.value = valor;
          // Disparar múltiples eventos
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          input.dispatchEvent(new Event('keyup', { bubbles: true }));
          input.dispatchEvent(new Event('keydown', { bubbles: true }));
          console.log('Campo desde_anaquel reconfigurado agresivamente con valor:', valor);
        }
      }, anaquelValor);
    }
    
    if (!intermediateState.hasta_anaquel) {
      console.log('🔄 Reconfigurando hasta_anaquel con método agresivo...');
      await page.evaluate((valor) => {
        const input = document.querySelector('input[name="hasta_anaquel"]');
        if (input) {
          // Limpiar el campo primero
          input.value = '';
          // Establecer el nuevo valor
          input.value = valor;
          // Disparar múltiples eventos
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          input.dispatchEvent(new Event('keyup', { bubbles: true }));
          input.dispatchEvent(new Event('keydown', { bubbles: true }));
          console.log('Campo hasta_anaquel reconfigurado agresivamente con valor:', valor);
        }
      }, anaquelValor);
    }
    
    // Esperar un poco más
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // Verificar estado final de los campos
  console.log('🔍 Verificando estado final de los filtros...');
  const finalFilterState = await page.evaluate(() => {
    const almacenSelect = document.querySelector('select[name="almacen"]');
    const desdeInput = document.querySelector('input[name="desde_anaquel"]');
    const hastaInput = document.querySelector('input[name="hasta_anaquel"]');
    
    return {
      almacen: almacenSelect ? almacenSelect.value : null,
      desde_anaquel: desdeInput ? desdeInput.value : null,
      hasta_anaquel: hastaInput ? hastaInput.value : null
    };
  });
  
  console.log('📊 Estado final de los filtros:', finalFilterState);
  
  console.log('Iniciando generación de archivo...');
  
  // Primer click en descargar (esto puede abrir un popup)
  console.log('🖱️ Primer click en generar archivo...');
  await page.click('a[href="javascript:enviar(\'xls\');"]');
  console.log('✅ Primer click ejecutado');
  
  // Esperar 5 segundos para que aparezca y se procese el popup
  console.log('⏳ Esperando 5 segundos para que se procese el popup...');
  await new Promise(r => setTimeout(r, 5000));
  
  // Segundo click en descargar (esto cierra el popup automáticamente)
  console.log('🖱️ Segundo click en generar archivo (para cerrar popup)...');
  await page.click('a[href="javascript:enviar(\'xls\');"]');
  console.log('✅ Segundo click ejecutado');
  
  // Verificar si realmente se inició la descarga
  console.log('🔍 Verificando si realmente se inició la descarga...');
  
  let downloadStarted = false;
  let attempts = 0;
  const maxAttempts = 20; // 20 intentos = 1 minuto total
  
  while (!downloadStarted && attempts < maxAttempts) {
    attempts++;
    console.log(`🔍 Intento ${attempts}/${maxAttempts}: Verificando estado de la página...`);
    
    try {
      const pageStatus = await page.evaluate(() => {
        // Buscar indicadores de que se está procesando la descarga
        const processingIndicators = {
          // Buscar texto que indique procesamiento
          hasProcessingText: document.body.innerText.toLowerCase().includes('procesando') || 
                            document.body.innerText.toLowerCase().includes('generando') ||
                            document.body.innerText.toLowerCase().includes('descargando') ||
                            document.body.innerText.toLowerCase().includes('preparando'),
          
          // Buscar elementos de carga
          hasLoadingElements: document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="progress"], [class*="wait"]').length > 0,
          
          // Buscar enlaces de descarga activos
          hasDownloadLinks: document.querySelectorAll('a[href*="descargar"], a[href*="download"]').length > 0,
          
          // Buscar paneles de proceso
          hasProcessPanel: !!document.querySelector('.slide-panel, .process-center-wrapper, [class*="process"], [class*="panel"]'),
          
          // Verificar si hay algún modal o popup activo
          hasActiveModals: document.querySelectorAll('.modal[style*="display: block"], .modal.show, .popup, .overlay').length > 0,
          
          // Información básica de la página
          pageTitle: document.title,
          url: window.location.href,
          bodyTextLength: document.body.innerText.length
        };
        
        return processingIndicators;
      });
      
      console.log(`📊 Estado de la página (intento ${attempts}):`, pageStatus);
      
      // Si encontramos indicadores de procesamiento, la descarga se inició
      if (pageStatus.hasProcessingText || pageStatus.hasLoadingElements || pageStatus.hasDownloadLinks || pageStatus.hasProcessPanel) {
        downloadStarted = true;
        console.log('✅ ¡Descarga iniciada! Se encontraron indicadores de procesamiento');
        break;
      }
      
      // Si hay modales activos, esperar un poco más
      if (pageStatus.hasActiveModals) {
        console.log('⏳ Hay modales activos, esperando que se procesen...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      
      // Si no hay indicadores, esperar y verificar nuevamente
      console.log('⏳ No se encontraron indicadores de procesamiento, esperando 3 segundos...');
      await new Promise(r => setTimeout(r, 3000));
      
    } catch (error) {
      console.log(`❌ Error verificando estado (intento ${attempts}):`, error.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  
  if (!downloadStarted) {
    console.log('⚠️ No se pudo confirmar que se inició la descarga después de 1 minuto');
    console.log('🔄 Continuando de todos modos para intentar encontrar el enlace...');
  } else {
    console.log('🎯 Descarga confirmada, esperando a que se complete el procesamiento...');
    // Esperar un poco más para que se complete el procesamiento
    await new Promise(r => setTimeout(r, 10000));
  }
  
  // Ahora buscar el enlace de descarga de manera inteligente
  console.log('🔍 Iniciando búsqueda inteligente del enlace de descarga...');
  
  let downloadLinkFound = false;
  let searchAttempts = 0;
  const maxSearchAttempts = 15; // 15 intentos = 45 segundos total
  
  while (!downloadLinkFound && searchAttempts < maxSearchAttempts) {
    searchAttempts++;
    console.log(`🔍 Búsqueda ${searchAttempts}/${maxSearchAttempts}: Buscando enlace de descarga...`);
    
    try {
      const downloadResult = await page.evaluate(() => {
        // Buscar enlaces de descarga en diferentes ubicaciones
        const downloadSelectors = [
          'a[href*="descargar"]',
          'a[href*="download"]',
          '[class*="download"] a',
          '[class*="descarga"] a',
          '.content a[href*="descargar"]',
          '.panel a[href*="descargar"]'
        ];
        
        let foundLink = null;
        let foundLocation = '';
        
        for (const selector of downloadSelectors) {
          const links = document.querySelectorAll(selector);
          if (links.length > 0) {
            foundLink = links[0];
            foundLocation = selector;
            break;
          }
        }
        
        if (foundLink) {
          return {
            success: true,
            href: foundLink.href,
            text: foundLink.textContent.trim(),
            location: foundLocation
          };
        }
        
        // Si no se encuentra con selectores específicos, buscar por texto
        const allLinks = document.querySelectorAll('a');
        const textBasedLinks = Array.from(allLinks).filter(link => {
          const text = (link.textContent || '').toLowerCase();
          return text.includes('descargar') || text.includes('download') || text.includes('bajar');
        });
        
        if (textBasedLinks.length > 0) {
          return {
            success: true,
            href: textBasedLinks[0].href,
            text: textBasedLinks[0].textContent.trim(),
            location: 'text-based search'
          };
        }
        
        return {
          success: false,
          message: 'No se encontraron enlaces de descarga',
          totalLinks: allLinks.length,
          pageTitle: document.title
        };
      });
      
      if (downloadResult.success) {
        console.log('✅ ¡Enlace de descarga encontrado!');
        console.log(`📥 Enlace: ${downloadResult.href}`);
        console.log(`📝 Texto: ${downloadResult.text}`);
        console.log(`📍 Ubicación: ${downloadResult.location}`);
        
        // Hacer click en el enlace de descarga
        console.log('🖱️ Haciendo click en el enlace de descarga...');
        await page.click(`a[href="${downloadResult.href}"]`);
        console.log('✅ Click en enlace de descarga ejecutado');
        
        downloadLinkFound = true;
        break;
      } else {
        console.log(`❌ Búsqueda ${searchAttempts}: ${downloadResult.message}`);
        console.log(`📊 Total de enlaces en la página: ${downloadResult.totalLinks}`);
        
        if (searchAttempts < maxSearchAttempts) {
          console.log('⏳ Esperando 3 segundos antes de la siguiente búsqueda...');
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      
    } catch (error) {
      console.log(`❌ Error en búsqueda ${searchAttempts}:`, error.message);
      if (searchAttempts < maxSearchAttempts) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  
  if (!downloadLinkFound) {
    console.log('❌ No se pudo encontrar el enlace de descarga después de todas las búsquedas');
    console.log('📸 Tomando screenshot para debugging...');
    
    try {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      console.log('📸 Screenshot tomado (base64 disponible)');
      
      // También capturar el HTML de la página
      const pageHTML = await page.content();
      console.log('📄 HTML de la página capturado para debugging');
      
    } catch (screenshotError) {
      console.log('❌ Error al tomar screenshot:', screenshotError.message);
    }
    
    throw new Error('No se pudo encontrar el enlace de descarga después de múltiples intentos');
  }
  
  // Esperar a que la descarga termine
  console.log('⏳ Esperando que la descarga termine...');
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

  // Leer el archivo Excel y extraer columnas 'existencia' y 'posición' por índice (G y N)
  let tabla = [];
  try {
    console.log('Leyendo archivo Excel:', finalFilePath);
    const workbook = xlsx.readFile(finalFilePath);
    const sheetName = workbook.SheetNames[0];
    console.log('Nombre de la hoja:', sheetName);
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    console.log('Primeras filas del archivo:', data.slice(0, 5));
    // Extraer columna G (índice 6) y N (índice 13)
    for (let i = 1; i < data.length; i++) {
      tabla.push({
        posicion: data[i][6], // Columna G
        existencia: data[i][13] // Columna N
      });
    }
    console.log('Ejemplo de datos extraídos:', tabla.slice(0, 5));
  } catch (e) {
    console.log('No se pudo leer el archivo Excel o extraer columnas:', e.message);
  }

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
    tabla
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
    return res.status(400).json({ status: 'error' });
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
    res.json(result.tabla);
  } catch (err) {
    console.log('=== ERROR EN EL FLUJO ===');
    console.error('Error completo:', err);
    console.error('Stack trace:', err.stack);
    res.status(500).json({ status: 'error' });
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

// Endpoint para debug del proceso de descarga
app.post('/debug-download', async (req, res) => {
  const almacenNombre = (req.body.almacen || 'MATRIZ').trim().toUpperCase();
  if (!almacenes[almacenNombre]) {
    return res.status(400).json({ error: 'Almacén no válido' });
  }
  
  const { valor: almacenValor, anaquel: anaquelValor } = almacenes[almacenNombre];
  
  try {
    const browser = await puppeteer.launch({ 
      headless: false, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    });
    
    const page = await browser.newPage();
    
    // Ir al sitio
    await page.goto('https://sanbenito.admintotal.com/admin/inventario/utilerias/inventario_fisico/descarga_archivos/?task_panel=1&first=1', {
      waitUntil: 'networkidle0', timeout: 60000
    });

    // Login
    if (await page.$('input[name="username"]')) {
      await page.type('input[name="username"]', USER);
      await page.type('input[name="password"]', PASS);
      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }),
        page.click('button[type="submit"]')
      ]);
    }

    // Configurar filtros
    await page.waitForSelector('input[type="checkbox"]', { timeout: 30000 });
    await page.$eval('input[name="usar_posicion"]', el => { if (el.checked) el.click(); });
    await page.$eval('input[name="con_existencia"]', el => { if (el.checked) el.click(); });
    await page.$eval('input[name="mostrar_existencias"]', el => { if (!el.checked) el.click(); });
    await page.select('select[name="almacen"]', almacenValor);
    await page.type('input[name="desde_anaquel"]', anaquelValor);
    await page.type('input[name="hasta_anaquel"]', anaquelValor);
    
    // Generar archivo
    await page.click('a[href="javascript:enviar(\'xls\');"]');
    await page.waitForSelector('.slide-panel.process-center-wrapper.visible', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 15000));

    // Debug del estado de la página
    const debugInfo = await page.evaluate(() => {
      const panel = document.querySelector('.slide-panel.process-center-wrapper.visible');
      if (!panel) return { error: 'Panel no encontrado' };
      
      const items = panel.querySelectorAll('.content ul li');
      const links = panel.querySelectorAll('a');
      const downloadLinks = panel.querySelectorAll('a[href*="descargar"]');
      
      return {
        panelFound: true,
        itemsCount: items.length,
        linksCount: links.length,
        downloadLinksCount: downloadLinks.length,
        panelHTML: panel.innerHTML,
        allLinks: Array.from(links).map(l => ({ href: l.href, text: l.textContent.trim() }))
      };
    });

    // Tomar screenshot
    const screenshot = await page.screenshot({ encoding: 'base64' });
    
    await browser.close();
    
    res.json({
      success: true,
      almacen: almacenNombre,
      debugInfo,
      screenshot: `data:image/png;base64,${screenshot}`
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});
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