import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Eta } from 'eta';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const eta = new Eta({ views: path.join(__dirname, 'views'), cache: process.env.NODE_ENV === 'production' });

const app = express();
const PORT = process.env.PORT || 3000;

app.engine('eta', (file, data, cb) => {
  try { cb(null, eta.render(path.relative(eta.config.views, file), data)); } catch (e) { cb(e); }
});
app.set('view engine', 'eta');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ronde', type: 'app' });
});

app.get('/', (req, res) => {
  res.render('index', { title: 'ronde' });
});

app.listen(PORT, () => {
  console.log(`ronde listening on port ${PORT}`);
});
