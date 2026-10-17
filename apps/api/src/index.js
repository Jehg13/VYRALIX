import { createApp, processPendingJobs, recoverInterruptedJobs } from './app.js';
import { closeDatabase } from './db.js';

const port = Number(process.env.API_PORT || 3001);
const host = '127.0.0.1';
const app = createApp();
recoverInterruptedJobs();
const mediaService = app.locals.mediaService;
mediaService.recoverInterruptedJobs();
const server = app.listen(port, host, () => {
  console.info(JSON.stringify({ level: 'info', message: 'Vyralix API disponible', host, port }));
});

const worker = setInterval(() => {
  try {
    processPendingJobs();
    mediaService.processQueue();
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'job_processing_failed', message: error.message }));
  }
}, 1500);
worker.unref();

function shutdown() {
  clearInterval(worker);
  void Promise.all([app.locals.automationService.shutdown(), mediaService.shutdown()]).then(() => {
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
