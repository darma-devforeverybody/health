const express = require('express');
const crypto = require('crypto');
const pool = require('../lib/db');
const { attachRelations } = require('../lib/activityRelations');
const VALID_CATEGORIES = require('../lib/categories');
const POINTS_BY_CATEGORY = require('../lib/points');
const { BONUS_POINT_OPTIONS } = POINTS_BY_CATEGORY;
const { adminToken, requireAdmin } = require('../middleware/adminAuth');

const router = require('../lib/asyncRouter')();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.cookie('admin_token', adminToken(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie('admin_token', { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ username: process.env.ADMIN_USERNAME });
});

// Admin can see username + password for every user.
router.get('/users', requireAdmin, async (req, res) => {
  const [rows] = await pool.query('SELECT id, full_name, password FROM users ORDER BY full_name ASC');
  res.json(rows);
});

// Admin can add users (and sets their password), but never delete them.
router.post('/users', requireAdmin, async (req, res) => {
  const { full_name, password } = req.body;
  if (!full_name || !full_name.trim() || !password) {
    return res.status(400).json({ error: 'full_name and password required' });
  }
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO users (id, full_name, password) VALUES (?, ?, ?)', [id, full_name.trim(), password]);
  const [rows] = await pool.query('SELECT id, full_name, password FROM users WHERE id = ?', [id]);
  res.status(201).json(rows[0]);
});

// Admin can (re)set a user's password. Still can't delete users.
router.put('/users/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });

  await pool.query('UPDATE users SET password = ? WHERE id = ?', [password, req.params.id]);
  const [rows] = await pool.query('SELECT id, full_name, password FROM users WHERE id = ?', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Activity report: filter by category/user/date range/caption search, sort, paginate.
router.get('/report', requireAdmin, async (req, res) => {
  const {
    category,
    user_id,
    date_from,
    date_to,
    search,
    points_awarded,
    sort_by = 'created_at',
    sort_dir = 'desc',
    limit = '25',
    offset = '0',
  } = req.query;

  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }
  if (points_awarded && !['true', 'false'].includes(points_awarded)) {
    return res.status(400).json({ error: 'points_awarded must be true or false' });
  }

  const sortableColumns = ['created_at', 'category'];
  const sortColumn = sortableColumns.includes(sort_by) ? sort_by : 'created_at';
  const sortDir = sort_dir === 'asc' ? 'ASC' : 'DESC';

  const pageSize = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const pageOffset = Math.max(Number(offset) || 0, 0);

  const where = ['parent_id IS NULL'];
  const params = [];
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (user_id) {
    where.push('user_id = ?');
    params.push(user_id);
  }
  if (date_from) {
    where.push('created_at >= ?');
    params.push(date_from);
  }
  if (date_to) {
    where.push('created_at <= ?');
    params.push(date_to);
  }
  if (search) {
    where.push('caption LIKE ?');
    params.push(`%${search}%`);
  }
  if (points_awarded === 'true') where.push('points > 0');
  if (points_awarded === 'false') where.push('points = 0');
  const whereSql = where.join(' AND ');

  const [[{ count }]] = await pool.query(`SELECT COUNT(*) as count FROM activities WHERE ${whereSql}`, params);
  const [rows] = await pool.query(
    // sortColumn/sortDir come from a fixed allowlist above, never straight from the query string.
    `SELECT * FROM activities WHERE ${whereSql} ORDER BY ${sortColumn} ${sortDir} LIMIT ? OFFSET ?`,
    [...params, pageSize, pageOffset]
  );
  const data = await attachRelations(rows, { withAuthor: true });

  res.json({ data, count, limit: pageSize, offset: pageOffset });
});

// Admin awards/revokes points on an activity. Value is fixed per category
// (see lib/points.js), except "bonus" where admin picks 5 or 10.
router.put('/activities/:id/points', requireAdmin, async (req, res) => {
  const { points } = req.body;
  if (!Number.isInteger(points) || points < 0) {
    return res.status(400).json({ error: 'points must be a non-negative integer' });
  }

  const [activityRows] = await pool.query('SELECT category FROM activities WHERE id = ?', [req.params.id]);
  if (!activityRows[0]) return res.status(404).json({ error: 'not found' });
  const category = activityRows[0].category;

  const valid =
    points === 0 ||
    (category === 'bonus' ? BONUS_POINT_OPTIONS.includes(points) : points === (POINTS_BY_CATEGORY[category] ?? 0));
  if (!valid) return res.status(400).json({ error: 'points value not allowed for this category' });

  await pool.query('UPDATE activities SET points = ? WHERE id = ?', [points, req.params.id]);
  const [rows] = await pool.query('SELECT * FROM activities WHERE id = ?', [req.params.id]);
  res.json(rows[0]);
});

// Leaderboard: total points per user, across every activity (anchor + children).
router.get('/leaderboard', requireAdmin, async (req, res) => {
  const [users] = await pool.query('SELECT id, full_name FROM users');
  const [activities] = await pool.query('SELECT user_id, points FROM activities');

  const totals = new Map(users.map((u) => [u.id, { user_id: u.id, full_name: u.full_name, points: 0 }]));
  for (const a of activities) {
    const row = totals.get(a.user_id);
    if (row) row.points += a.points || 0;
  }

  res.json([...totals.values()].sort((a, b) => b.points - a.points));
});

module.exports = router;
