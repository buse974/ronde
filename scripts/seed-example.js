// Ajoute la tâche d'exemple (surveillance disque) si elle n'existe pas.
// Usage : docker exec ronde node scripts/seed-example.js
import 'dotenv/config';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { DISK_TASK } from '../server/examples.js';

const store = createStore(openDb(loadConfig().dbPath));
if (store.listTasks().some((t) => t.name === DISK_TASK.name)) {
  console.log('Tâche déjà présente.');
} else {
  console.log(`Tâche créée (#${store.createTask(DISK_TASK)}).`);
}
