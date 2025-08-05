// refresh-token-generator.js
require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

// Scopes necesarios para Google Drive
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

async function generateRefreshToken() {
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  // Generar URL de autorización
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Fuerza a mostrar la pantalla de consentimiento
  });

  console.log('🔗 Abre este enlace en tu navegador:');
  console.log(authUrl);
  console.log('\n📋 Después de autorizar, copia el código de autorización aquí:');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Código de autorización: ', async (code) => {
    try {
      const { tokens } = await oauth2Client.getToken(code);
      
      console.log('\n✅ ¡Tokens obtenidos exitosamente!');
      console.log('\n🔑 Tu nuevo REFRESH_TOKEN es:');
      console.log(tokens.refresh_token);
      
      console.log('\n📝 Actualiza tu archivo .env con:');
      console.log(`REFRESH_TOKEN=${tokens.refresh_token}`);
      
      console.log('\n🚀 También actualiza esta variable en Render.com');
      
      // Probar el token
      oauth2Client.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      
      try {
        const res = await drive.about.get({ fields: 'user' });
        console.log(`\n✅ Token validado correctamente para: ${res.data.user.emailAddress}`);
      } catch (error) {
        console.log('\n⚠️  Token obtenido pero no se pudo validar:', error.message);
      }
      
    } catch (error) {
      console.error('\n❌ Error obteniendo tokens:', error.message);
    } finally {
      rl.close();
    }
  });
}

// Verificar que tenemos las credenciales necesarias
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Faltan CLIENT_ID o CLIENT_SECRET en el archivo .env');
  process.exit(1);
}

generateRefreshToken();