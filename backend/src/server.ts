import { createApp } from './app';
import { config } from './config';
import { pool } from './db';
import { coexRegistry } from './coex/registry';
import { startScheduler, stopScheduler } from './services/brightnessScheduler';
import { startRentalExpiryCron, stopRentalExpiryCron } from './services/rentalExpiry';
import { startContractRenewalCron, stopContractRenewalCron } from './services/contractRenewal';
import { startAlertsCron, stopAlertsCron } from './services/deviceAlertsService';

async function main() {
  const app = createApp();
  const server = app.listen(config.apiPort, () => {
    // eslint-disable-next-line no-console
    console.log(`api listening on :${config.apiPort} (${config.nodeEnv})`);
  });

  startScheduler();
  startRentalExpiryCron();
  startContractRenewalCron();
  startAlertsCron();

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    stopScheduler();
    stopRentalExpiryCron();
    stopContractRenewalCron();
    stopAlertsCron();
    server.close();
    await coexRegistry.closeAll();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
