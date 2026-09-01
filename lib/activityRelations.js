const pool = require('./db');

// Attaches photos, child rows (with their own photos), and optionally the
// author's name to a list of anchor activity rows — mirrors the nested
// select Supabase used to do in one call (photos(*), children:activities!parent_id(*, photos(*)), users(full_name)).
async function attachRelations(anchors, { withAuthor = false } = {}) {
  if (anchors.length === 0) return anchors;
  const anchorIds = anchors.map((a) => a.id);

  const [children] = await pool.query(
    'SELECT * FROM activities WHERE parent_id IN (?) ORDER BY created_at ASC',
    [anchorIds]
  );
  const allIds = [...anchorIds, ...children.map((c) => c.id)];
  const [photos] = await pool.query('SELECT * FROM photos WHERE activity_id IN (?)', [allIds]);

  const photosByActivity = new Map();
  for (const p of photos) {
    if (!photosByActivity.has(p.activity_id)) photosByActivity.set(p.activity_id, []);
    photosByActivity.get(p.activity_id).push(p);
  }

  const childrenByParent = new Map();
  for (const c of children) {
    if (!childrenByParent.has(c.parent_id)) childrenByParent.set(c.parent_id, []);
    childrenByParent.get(c.parent_id).push({ ...c, photos: photosByActivity.get(c.id) || [] });
  }

  let usersById = new Map();
  if (withAuthor) {
    const userIds = [...new Set(anchors.map((a) => a.user_id))];
    const [users] = await pool.query('SELECT id, full_name FROM users WHERE id IN (?)', [userIds]);
    usersById = new Map(users.map((u) => [u.id, u]));
  }

  return anchors.map((a) => ({
    ...a,
    photos: photosByActivity.get(a.id) || [],
    children: childrenByParent.get(a.id) || [],
    ...(withAuthor ? { users: usersById.get(a.user_id) || null } : {}),
  }));
}

module.exports = { attachRelations };
