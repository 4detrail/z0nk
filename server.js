const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Veritabanı
const db = new sqlite3.Database('chat.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    from_user TEXT,
    to_user TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Kayıt
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', 
        [username, hashed], 
        (err) => {
            if (err) return res.status(400).json({ error: 'Kullanıcı var!' });
            res.json({ success: true });
        });
});

// Giriş
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Hatalı giriş!' });
        }
        
        const token = jwt.sign({ username }, 'GIZLI_ANAHTAR', { expiresIn: '24h' });
        res.json({ token, username });
    });
});

// Mesaj gönder
app.post('/send', (req, res) => {
    const { from, to, message, token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        db.run('INSERT INTO messages (from_user, to_user, message) VALUES (?, ?, ?)',
            [from, to, message]);
        res.json({ success: true });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

// Mesajları al
app.post('/messages', (req, res) => {
    const { username, token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        db.all('SELECT * FROM messages WHERE to_user = ? OR from_user = ? ORDER BY timestamp DESC LIMIT 100',
            [username, username], (err, rows) => {
                res.json(rows);
            });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

app.listen(3000, () => console.log('🔥 Server http://localhost:3000'));
