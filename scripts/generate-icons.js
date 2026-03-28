#!/usr/bin/env node
// Generates simple PWA icons using Node.js canvas
// Run: node scripts/generate-icons.js
// Requires: npm install canvas

'use strict';

const fs = require('fs');
const path = require('path');

function generateSvgIcon(size) {
  const pad = Math.round(size * 0.1);
  const inner = size - pad * 2;
  // Diamond suit symbol
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.18)}" fill="#2563eb"/>
  <text x="${size/2}" y="${size/2 + size*0.15}" font-size="${inner}" font-family="serif" fill="white" text-anchor="middle" dominant-baseline="middle">♦</text>
</svg>`;
}

const iconsDir = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

// Write SVG versions that browsers can use as fallback
fs.writeFileSync(path.join(iconsDir, 'icon-192.svg'), generateSvgIcon(192));
fs.writeFileSync(path.join(iconsDir, 'icon-512.svg'), generateSvgIcon(512));

console.log('SVG icons generated in public/icons/');
console.log('');
console.log('To generate PNG icons, run:');
console.log('  npm install canvas && node scripts/generate-icons-png.js');
console.log('');
console.log('Or convert the SVGs manually using any image editor or:');
console.log('  convert public/icons/icon-192.svg public/icons/icon-192.png');
console.log('  convert public/icons/icon-512.svg public/icons/icon-512.png');
