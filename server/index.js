'use strict';

// Standalone entry point: `npm start` (also what Render runs).
const { start } = require('./app');

const port = Number(process.env.PORT) || 3000;

start({ port, host: '0.0.0.0' }).then(({ port: actual }) => {
  console.log(`Live Interrogation server running on http://localhost:${actual}`);
});
