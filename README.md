# Ejemplo: Subir archivo a Google Drive con Node.js y OAuth2

## Pasos

1. **Crea un proyecto en Google Cloud Console**
   - Ve a https://console.cloud.google.com/
   - Habilita la API de Google Drive.
   - Crea credenciales de tipo "OAuth client ID" (aplicación de escritorio).
   - Descarga el archivo `credentials.json` y colócalo en la raíz de este proyecto.

2. **Instala dependencias**

```bash
npm install googleapis
```

3. **Ejecuta el script**

```bash
node index.js
```

La primera vez, te pedirá autorizar la app en una URL y pegar el código de autorización.

4. **Verifica en tu Google Drive**

Deberías ver el archivo `archivo_ejemplo.txt` subido. 