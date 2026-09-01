require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const usersRouter = require('../routes/users');
const activitiesRouter = require('../routes/activities');
const photosRouter = require('../routes/photos');
const adminRouter = require('../routes/admin');

const app = express();
const webDist = path.join(__dirname, '..', 'web', 'dist');

app.use(cors());
app.use(express.json());

// Auth state must never be served stale from cache — always hit the server.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api', (req, res) => res.json({ status: 'ok' }));

app.use('/api/users', usersRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/photos', photosRouter);
app.use('/api/admin', adminRouter);

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
  next();
});

// Mirrors the old Supabase {data,error} behavior — a DB/route error becomes
// a 400 JSON response instead of an unhandled rejection that kills the process.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message });
});

// Local dev convenience: serve the built React app from this same process.
// In production on Vercel, static files and SPA fallback are handled by
// vercel.json (outputDirectory + rewrites) before requests ever reach this function.
app.use(express.static(webDist));
app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`listening on ${port}`));
}

module.exports = app;
