const express = require('express');
const pool = require('../lib/db');

const router = require('../lib/asyncRouter')();

// Public listing — never select password here.
router.get('/', async (req, res) => {
  const [rows] = await pool.query('SELECT id, full_name FROM users');
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const [rows] = await pool.query('SELECT id, full_name FROM users WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Total points across every activity (anchor + children) for one user.
router.get('/:id/points', async (req, res) => {
  const [rows] = await pool.query('SELECT points FROM activities WHERE user_id = ?', [req.params.id]);
  const total = rows.reduce((sum, a) => sum + (a.points || 0), 0);
  res.json({ points: total });
});

// Login: full_name + password must match exactly. No auto-create —
// only an admin can add new users (and set their password).
router.post('/login', async (req, res) => {
  const { full_name, password } = req.body;
  if (!full_name || !full_name.trim() || !password) {
    return res.status(400).json({ error: 'full_name and password required' });
  }
  const name = full_name.trim();

  const [rows] = await pool.query('SELECT id, full_name, password FROM users WHERE full_name = ? LIMIT 1', [name]);
  const existing = rows[0];
  if (!existing || existing.password !== password) {
    return res.status(401).json({ error: 'Nama atau kata sandi salah.' });
  }

  res.json({ id: existing.id, full_name: existing.full_name });
});

module.exports = router;
