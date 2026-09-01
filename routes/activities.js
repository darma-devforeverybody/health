const express = require("express");
const crypto = require("crypto");
const pool = require("../lib/db");
const supabase = require("../lib/supabase");
const VALID_CATEGORIES = require("../lib/categories");
const { attachRelations } = require("../lib/activityRelations");

const router = require('../lib/asyncRouter')();

router.get("/", async (req, res) => {
	const { user_id, limit = "12", offset = "0" } = req.query;

	const pageSize = Math.min(Math.max(Number(limit) || 12, 1), 50);
	const pageOffset = Math.max(Number(offset) || 0, 0);
	const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const where = ["parent_id IS NULL", "created_at >= ?"];
	const params = [oneWeekAgo];
	if (user_id) {
		where.push("user_id = ?");
		params.push(user_id);
	}
	const whereSql = where.join(" AND ");

	const [[{ count }]] = await pool.query(`SELECT COUNT(*) as count FROM activities WHERE ${whereSql}`, params);
	const [rows] = await pool.query(
		`SELECT * FROM activities WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
		[...params, pageSize, pageOffset]
	);
	const data = await attachRelations(rows, { withAuthor: true });
	res.json({ data, count, limit: pageSize, offset: pageOffset });
});

router.get("/:id", async (req, res) => {
	const [rows] = await pool.query("SELECT * FROM activities WHERE id = ?", [req.params.id]);
	if (!rows[0]) return res.status(404).json({ error: "not found" });
	const [enriched] = await attachRelations(rows);
	res.json(enriched);
});

router.post("/", async (req, res) => {
	const { user_id, category, caption, parent_id } = req.body;
	if (!user_id || !category) {
		return res.status(400).json({ error: "user_id and category required" });
	}
	if (!VALID_CATEGORIES.includes(category)) {
		return res
			.status(400)
			.json({
				error: `category must be one of: ${VALID_CATEGORIES.join(", ")}`,
			});
	}

	// Only the anchor row (no parent_id) starts a new post — the other
	// categories in the same submission are attached to it via parent_id.
	// One post per user per day, gated on the anchor.
	if (!parent_id) {
		const startOfDay = new Date();
		startOfDay.setHours(0, 0, 0, 0);
		const [[{ count }]] = await pool.query(
			"SELECT COUNT(*) as count FROM activities WHERE user_id = ? AND parent_id IS NULL AND created_at >= ?",
			[user_id, startOfDay]
		);
		if (count > 0) {
			return res.status(409).json({ error: "Kamu sudah memposting hari ini. Coba lagi besok." });
		}
	}

	const id = crypto.randomUUID();
	await pool.query(
		"INSERT INTO activities (id, user_id, category, caption, parent_id) VALUES (?, ?, ?, ?, ?)",
		[id, user_id, category, caption ?? null, parent_id ?? null]
	);
	const [rows] = await pool.query("SELECT * FROM activities WHERE id = ?", [id]);
	res.status(201).json(rows[0]);
});

router.put("/:id", async (req, res) => {
	const { category, caption } = req.body;
	if (category && !VALID_CATEGORIES.includes(category)) {
		return res
			.status(400)
			.json({
				error: `category must be one of: ${VALID_CATEGORIES.join(", ")}`,
			});
	}

	const [existingRows] = await pool.query("SELECT points FROM activities WHERE id = ?", [req.params.id]);
	if (!existingRows[0]) return res.status(404).json({ error: "not found" });

	// Same rule as delete — once admin has scored it, the record is locked.
	if (existingRows[0].points > 0) {
		return res.status(400).json({
			error: "Aktivitas ini sudah diberi poin dan tidak bisa diubah.",
		});
	}

	const sets = [];
	const params = [];
	if (category) {
		sets.push("category = ?");
		params.push(category);
	}
	if (caption !== undefined) {
		sets.push("caption = ?");
		params.push(caption);
	}
	if (sets.length > 0) {
		params.push(req.params.id);
		await pool.query(`UPDATE activities SET ${sets.join(", ")} WHERE id = ?`, params);
	}

	const [rows] = await pool.query("SELECT * FROM activities WHERE id = ?", [req.params.id]);
	res.json(rows[0]);
});

async function removeStorageFolder(activityId) {
	const { data: files, error: listError } = await supabase.storage
		.from("photos")
		.list(activityId);
	if (!listError && files?.length) {
		const paths = files.map((f) => `${activityId}/${f.name}`);
		await supabase.storage.from("photos").remove(paths);
	}
}

router.delete("/:id", async (req, res) => {
	const activityId = req.params.id;

	const [activityRows] = await pool.query(
		"SELECT id, parent_id, category, points FROM activities WHERE id = ?",
		[activityId]
	);
	const activity = activityRows[0];
	if (!activity) return res.status(404).json({ error: "not found" });

	// A child category can be removed on its own (editing a submission), as
	// long as it isn't the mandatory mindful nutrition companion and isn't
	// already scored. The anchor row itself still requires deleting the whole
	// submission — see below.
	if (activity.parent_id) {
		if (activity.category === "mindful nutrition") {
			return res.status(400).json({
				error: "Mindful nutrition wajib ada dan tidak bisa dihapus.",
			});
		}
		if (activity.points > 0) {
			return res.status(400).json({
				error: "Aktivitas ini sudah diberi poin dan tidak bisa dihapus.",
			});
		}
		await removeStorageFolder(activityId);
		await pool.query("DELETE FROM activities WHERE id = ?", [activityId]);
		return res.status(204).send();
	}

	const [children] = await pool.query("SELECT id, points FROM activities WHERE parent_id = ?", [activityId]);

	// Once the admin has awarded points anywhere in this submission, it's locked
	// from deletion — otherwise a user could erase the record behind the points.
	if (activity.points > 0 || children.some((c) => c.points > 0)) {
		return res.status(400).json({
			error: "Aktivitas ini sudah diberi poin dan tidak bisa dihapus.",
		});
	}

	// Photos are uploaded under a storage folder named after the activity id
	// (see routes/photos.js upload path) — remove the actual files first,
	// otherwise deleting the rows just orphans them in the bucket forever.
	await removeStorageFolder(activityId);
	for (const child of children) {
		await removeStorageFolder(child.id);
	}

	// Children (and every photo row, via its own FK) cascade-delete in MySQL
	// once the anchor row is gone — see activities_parent_id_fkey / photos_activity_id_fkey.
	await pool.query("DELETE FROM activities WHERE id = ?", [activityId]);
	res.status(204).send();
});

module.exports = router;
