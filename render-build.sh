#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# npm run build # descomenta si tu proyecto necesita compilar algo

# Manejo de cache de Puppeteer
if [[ ! -d $PUPPETEER_CACHE_DIR ]]; then 
  echo "...Copiando caché de Puppeteer desde el caché de compilación" 
  if [[ -d "$XDG_CACHE_HOME/puppeteer/" ]]; then
  cp -R "$XDG_CACHE_HOME/puppeteer/" "$PUPPETEER_CACHE_DIR"
else
  echo "No se encontró la caché de Puppeteer en $XDG_CACHE_HOME/puppeteer/"
fi

else 
  echo "...Guardando caché de Puppeteer en el caché de compilación" 
  cp -R $PUPPETEER_CACHE_DIR $XDG_CACHE_HOME
fi
