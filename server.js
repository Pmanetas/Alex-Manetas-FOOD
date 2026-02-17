const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data directories exist
// On Render, use the persistent disk mount path; locally use ./data
const DATA_DIR = process.env.RENDER ? '/opt/render/project/src/data' : path.join(__dirname, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const DATA_FILE = path.join(DATA_DIR, 'timesheets.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Video upload config
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, VIDEOS_DIR),
    filename: (req, file, cb) => {
        const { dateKey, meal } = req.params;
        const ext = path.extname(file.originalname);
        cb(null, `${dateKey}_meal${meal}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'));
        }
    }
});

// --- Helper ---
function readData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// --- API Routes ---

// Get all timesheet data
app.get('/api/data', (req, res) => {
    res.json(readData());
});

// Save data for a specific date
app.post('/api/data/:dateKey', (req, res) => {
    const data = readData();
    const { dateKey } = req.params;
    data[dateKey] = { ...data[dateKey], ...req.body };
    writeData(data);
    res.json({ ok: true });
});

// Upload video for a date + meal
app.post('/api/video/:dateKey/:meal', upload.single('video'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

    const { dateKey, meal } = req.params;
    const data = readData();
    if (!data[dateKey]) data[dateKey] = {};
    if (!data[dateKey].videos) data[dateKey].videos = {};
    data[dateKey].videos[`meal${meal}`] = req.file.filename;
    writeData(data);

    res.json({ ok: true, filename: req.file.filename });
});

// Get video file
app.get('/api/video/:dateKey/:meal', (req, res) => {
    const { dateKey, meal } = req.params;
    const data = readData();
    const filename = data[dateKey]?.videos?.[`meal${meal}`];
    if (!filename) return res.status(404).json({ error: 'No video found' });

    const filePath = path.join(VIDEOS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

    res.sendFile(filePath);
});

// Delete video for a date + meal
app.delete('/api/video/:dateKey/:meal', (req, res) => {
    const { dateKey, meal } = req.params;
    const data = readData();
    const filename = data[dateKey]?.videos?.[`meal${meal}`];

    if (filename) {
        const filePath = path.join(VIDEOS_DIR, filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        delete data[dateKey].videos[`meal${meal}`];
        writeData(data);
    }
    res.json({ ok: true });
});

// Clear all data
app.delete('/api/data', (req, res) => {
    writeData({});
    // Remove all video files
    fs.readdirSync(VIDEOS_DIR).forEach(f => {
        fs.unlinkSync(path.join(VIDEOS_DIR, f));
    });
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`Alex Timesheets running at http://localhost:${PORT}`);
});
