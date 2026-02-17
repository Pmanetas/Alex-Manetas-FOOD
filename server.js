require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase setup
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const TABLE = 'Videos'; // table name in Supabase
const BUCKET = 'Videos'; // storage bucket name

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Temp storage for multer (buffer in memory, then upload to Supabase)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max (Supabase free limit)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'));
        }
    }
});

// --- API Routes ---

// Get all timesheet data
app.get('/api/data', async (req, res) => {
    try {
        const { data, error } = await supabase.from(TABLE).select('*');
        if (error) throw error;

        // Convert array of rows into { dateKey: { meal1, meal2, meal3, note } } format
        const result = {};
        data.forEach(row => {
            result[row.date_key] = {
                meal1: row.meal1,
                meal2: row.meal2,
                meal3: row.meal3,
                note: row.note || ''
            };
        });

        // Check which dates have videos in storage
        const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
        if (files) {
            files.forEach(f => {
                // filename format: 2026-02-17_meal1.mp4
                const match = f.name.match(/^(\d{4}-\d{2}-\d{2})_meal(\d)/);
                if (match) {
                    const [, dateKey, mealNum] = match;
                    if (!result[dateKey]) result[dateKey] = {};
                    if (!result[dateKey].videos) result[dateKey].videos = {};
                    result[dateKey].videos[`meal${mealNum}`] = f.name;
                }
            });
        }

        res.json(result);
    } catch (err) {
        console.error('GET /api/data error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Save data for a specific date (upsert)
app.post('/api/data/:dateKey', async (req, res) => {
    try {
        const { dateKey } = req.params;
        const updates = req.body;

        const row = { date_key: dateKey };
        if ('meal1' in updates) row.meal1 = updates.meal1;
        if ('meal2' in updates) row.meal2 = updates.meal2;
        if ('meal3' in updates) row.meal3 = updates.meal3;
        if ('note' in updates) row.note = updates.note;

        const { error } = await supabase
            .from(TABLE)
            .upsert(row, { onConflict: 'date_key' });

        if (error) throw error;
        res.json({ ok: true });
    } catch (err) {
        console.error('POST /api/data error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Upload video for a date + meal
app.post('/api/video/:dateKey/:meal', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

    try {
        const { dateKey, meal } = req.params;
        const ext = path.extname(req.file.originalname) || '.mp4';
        const filename = `${dateKey}_meal${meal}${ext}`;

        // Delete old file first (if exists)
        await supabase.storage.from(BUCKET).remove([filename]);

        // Upload new file
        const { error } = await supabase.storage
            .from(BUCKET)
            .upload(filename, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (error) throw error;
        res.json({ ok: true, filename });
    } catch (err) {
        console.error('Upload error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Get video URL (redirect to Supabase public URL)
app.get('/api/video/:dateKey/:meal', async (req, res) => {
    try {
        const { dateKey, meal } = req.params;

        // List files to find the right one (could be .mp4, .mov, etc)
        const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
        const prefix = `${dateKey}_meal${meal}`;
        const file = files?.find(f => f.name.startsWith(prefix));

        if (!file) return res.status(404).json({ error: 'No video found' });

        const { data } = supabase.storage.from(BUCKET).getPublicUrl(file.name);
        res.redirect(data.publicUrl);
    } catch (err) {
        console.error('GET video error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete video for a date + meal
app.delete('/api/video/:dateKey/:meal', async (req, res) => {
    try {
        const { dateKey, meal } = req.params;

        const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
        const prefix = `${dateKey}_meal${meal}`;
        const toDelete = files?.filter(f => f.name.startsWith(prefix)).map(f => f.name) || [];

        if (toDelete.length > 0) {
            await supabase.storage.from(BUCKET).remove(toDelete);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('DELETE video error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Clear all data
app.delete('/api/data', async (req, res) => {
    try {
        // Delete all rows
        await supabase.from(TABLE).delete().neq('date_key', '');

        // Delete all videos
        const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
        if (files?.length > 0) {
            await supabase.storage.from(BUCKET).remove(files.map(f => f.name));
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('Clear error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Alex Timesheets running at http://localhost:${PORT}`);
});
