#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {spawn} = require('node:child_process');

const runner = path.join(__dirname, 'x-delete-playwright.js');
const child = spawn(process.execPath, [runner, '--mode=reposts', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('error', error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
