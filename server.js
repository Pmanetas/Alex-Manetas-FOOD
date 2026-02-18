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
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video files are allowed'));
    }
});

// --- Helpers: pack/unpack note + timestamps into one text field ---
function parseNote(raw) {
    if (!raw) return { text: '', times: {}, extra: {} };
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && 'text' in parsed) {
            return { text: parsed.text || '', times: parsed.times || {}, extra: parsed.extra || {} };
        }
    } catch {}
    return { text: raw, times: {}, extra: {} };
}

function packNote(text, times, extra) {
    return JSON.stringify({ text: text || '', times: times || {}, extra: extra || {} });
}

// --- API Routes ---

// Get all timesheet data
app.get('/api/data', async (req, res) => {
    try {
        const { data, error } = await supabase.from(TABLE).select('*');
        if (error) throw error;

        const result = {};
        data.forEach(row => {
            const { text, times, extra } = parseNote(row.note);
            result[row.date_key] = {
                meal1: row.meal1,
                meal2: row.meal2,
                meal3: row.meal3,
                meal4: extra.meal4 || false,
                note: text,
                ...times
            };
        });

        // Check which dates have videos in storage
        const { data: files } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
        if (files) {
            files.forEach(f => {
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

        // Get existing row to preserve data
        const { data: existing } = await supabase.from(TABLE).select('*').eq('date_key', dateKey).single();
        const { text: existingNote, times, extra } = parseNote(existing?.note);

        const row = { date_key: dateKey };
        let noteText = existingNote;

        if ('meal1' in updates) {
            row.meal1 = updates.meal1;
            if (updates.meal1) times.meal1_time = new Date().toISOString();
            else delete times.meal1_time;
        }
        if ('meal2' in updates) {
            row.meal2 = updates.meal2;
            if (updates.meal2) times.meal2_time = new Date().toISOString();
            else delete times.meal2_time;
        }
        if ('meal3' in updates) {
            row.meal3 = updates.meal3;
            if (updates.meal3) times.meal3_time = new Date().toISOString();
            else delete times.meal3_time;
        }
        if ('meal4' in updates) {
            extra.meal4 = updates.meal4;
            if (updates.meal4) times.meal4_time = new Date().toISOString();
            else delete times.meal4_time;
        }
        if ('note' in updates) noteText = updates.note;

        row.note = packNote(noteText, times, extra);

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

        await supabase.storage.from(BUCKET).remove([filename]);

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
        await supabase.from(TABLE).delete().neq('date_key', '');

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
