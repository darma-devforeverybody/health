const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabase');
const pool = require('../lib/db');
const crypto = require('crypto');

const router = require('../lib/asyncRouter')();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
const IMAGE_API_BASE = `${process.env.IMAGE_API_ORIGIN}/image_ricola/api/image`;

router.get('/', async (req, res) => {
  const { activity_id } = req.query;
  const [rows] = activity_id
    ? await pool.query('SELECT * FROM photos WHERE activity_id = ?', [activity_id])
    : await pool.query('SELECT * FROM photos');
  res.json(rows);
});

// Issue a signed upload URL so the browser can upload the file straight to
// Supabase Storage — bypassing this server entirely. Needed because Vercel's
// serverless functions cap request bodies at ~4.5MB, too small for videos
// (and some photos).
router.post('/sign-upload', async (req, res) => {
  const { activity_id, filename } = req.body;
  if (!activity_id || !filename) {
    return res.status(400).json({ error: 'activity_id and filename required' });
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${activity_id}/${Date.now()}-${safeName}`;

  const { data, error } = await supabase.storage.from('photos').createSignedUploadUrl(path);
  if (error) return res.status(400).json({ error: error.message });

  const { data: { publicUrl } } = supabase.storage.from('photos').getPublicUrl(path);
  res.json({ path, token: data.token, signedUrl: data.signedUrl, publicUrl });
});

// Proxies an image to the image_ricola API — the browser can't call it
// directly since the Authorization token is a static shared secret that
// must never reach client-side code.
router.post('/image-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });

  const form = new FormData();
  form.append('file', new Blob([req.file.buffer]), req.file.originalname);
  form.append('title', 'Wellness Activity Photo');
  form.append('description', 'Uploaded via wellness app');
  form.append('keyword', 'wellness');
  form.append('public', '1');

  try {
    const createRes = await fetch(`${IMAGE_API_BASE}/create`, {
      method: 'POST',
      headers: { Authorization: process.env.IMAGE_API_AUTH_TOKEN },
      body: form,
    });
    const created = await createRes.json().catch(() => null);
    if (!createRes.ok || !created?.image_id) {
      return res.status(502).json({ error: 'Gagal mengunggah gambar ke server eksternal.' });
    }

    const linkRes = await fetch(`${IMAGE_API_BASE}/fetch_link/${created.image_id}/1600/1600/public`, {
      headers: { Authorization: process.env.IMAGE_API_AUTH_TOKEN },
    });
    const link = await linkRes.json().catch(() => null);
    if (!linkRes.ok || !link?.url) {
      return res.status(502).json({ error: 'Gagal mengambil URL gambar.' });
    }

    res.json({ url: `${process.env.IMAGE_API_ORIGIN}${link.url}` });
  } catch {
    res.status(502).json({ error: 'Gagal terhubung ke server gambar eksternal.' });
  }
});

// Create a photo/video record from an already-uploaded URL
router.post('/', async (req, res) => {
  const { activity_id, url } = req.body;
  if (!activity_id || !url) {
    return res.status(400).json({ error: 'activity_id and url required' });
  }

  const [activityRows] = await pool.query('SELECT points FROM activities WHERE id = ?', [activity_id]);
  if (!activityRows[0]) return res.status(404).json({ error: 'not found' });
  // Same rule as editing the activity itself — once scored, it's locked.
  if (activityRows[0].points > 0) {
    return res.status(400).json({ error: 'Aktivitas ini sudah diberi poin dan tidak bisa diubah.' });
  }

  const id = crypto.randomUUID();
  await pool.query('INSERT INTO photos (id, activity_id, url) VALUES (?, ?, ?)', [id, activity_id, url]);
  const [rows] = await pool.query('SELECT * FROM photos WHERE id = ?', [id]);
  res.status(201).json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT photos.activity_id, activities.points
     FROM photos JOIN activities ON activities.id = photos.activity_id
     WHERE photos.id = ?`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  if (rows[0].points > 0) {
    return res.status(400).json({ error: 'Aktivitas ini sudah diberi poin dan tidak bisa diubah.' });
  }

  await pool.query('DELETE FROM photos WHERE id = ?', [req.params.id]);
  res.status(204).send();
});

module.exports = router;
