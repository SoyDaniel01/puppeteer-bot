#!/usr/bin/env bash
# exit on error
set -o errexit

# Instala dependencias
npm install

# Fuerza instalación de Chromium

npx puppeteer browsers install chrome

# Puedes descomentar esto si tienes una carpeta build
# npm run build