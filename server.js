const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const db = new sqlite3.Database('chat.db');

// Kullanıcılar tablosu
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Odalar tablosu (oda numaraları otomatik)
db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    room_code TEXT UNIQUE,
    room_name TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Mesajlar tablosu (oda bazlı)
db.run(`CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY,
    room_code TEXT,
    from_user TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Kullanıcının aktif odası
db.run(`CREATE TABLE IF NOT EXISTS user_room (
    username TEXT PRIMARY KEY,
    current_room TEXT
)`);

// Oda kodu oluşturucu
function generateRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '#';
    for(let i = 0; i < 2; i++) {
        code += letters[Math.floor(Math.random() * letters.length)];
    }
    for(let i = 0; i < 3; i++) {
        code += numbers[Math.floor(Math.random() * numbers.length)];
    }
    return code;
}

// ============ ODALAR ============

// Oda oluştur
app.post('/create_room', async (req, res) => {
    const { username, room_name, token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        let room_code;
        let exists = true;
        
        // Benzersiz oda kodu oluştur
        while(exists) {
            room_code = generateRoomCode();
            const check = await new Promise((resolve) => {
                db.get('SELECT room_code FROM rooms WHERE room_code = ?', [room_code], (err, row) => {
                    resolve(row);
                });
            });
            if(!check) exists = false;
        }
        
        db.run('INSERT INTO rooms (room_code, room_name, created_by) VALUES (?, ?, ?)',
            [room_code, room_name, username],
            (err) => {
                if(err) return res.status(400).json({ error: 'Oda oluşturulamadı!' });
                res.json({ success: true, room_code: room_code });
            });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

// Odaya katıl
app.post('/join_room', (req, res) => {
    const { username, room_code, token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        // Oda var mı kontrol et
        db.get('SELECT room_code FROM rooms WHERE room_code = ?', [room_code], (err, room) => {
            if(!room) {
                return res.status(404).json({ error: 'Oda bulunamadı!' });
            }
            
            // Kullanıcının aktif odasını güncelle
            db.run('INSERT OR REPLACE INTO user_room (username, current_room) VALUES (?, ?)',
                [username, room_code],
                (err) => {
                    if(err) return res.status(400).json({ error: 'Odaya katılınamadı!' });
                    res.json({ success: true, room_code: room_code });
                });
        });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

// Kullanıcının aktif odasını getir
app.post('/current_room', (req, res) => {
    const { username, token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        db.get('SELECT current_room FROM user_room WHERE username = ?', [username], (err, row) => {
            res.json({ room_code: row ? row.current_room : null });
        });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

// Tüm odaları listele
app.post('/list_rooms', (req, res) => {
    const { token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        db.all('SELECT room_code, room_name, created_by FROM rooms ORDER BY created_at DESC', [], (err, rows) => {
            res.json(rows);
        });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

// ============ MESAJLAR ============

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

// Mesaj gönder (aktif odaya)
app.post('/send', (req, res) => {
    const { from, message, token } = req.body;
    
    try {
        const decoded = jwt.verify(token, 'GIZLI_ANAHTAR');
        
        // Kullanıcının aktif odasını bul
        db.get('SELECT current_room FROM user_room WHERE username = ?', [from], (err, room) => {
            if(!room || !room.current_room) {
                return res.status(400).json({ error: 'Önce bir odaya katılın!' });
            }
            
            db.run('INSERT INTO room_messages (room_code, from_user, message) VALUES (?, ?, ?)',
                [room.current_room, from, message],
                (err) => {
                    if(err) return res.status(400).json({ error: 'Mesaj gönderilemedi!' });
                    res.json({ success: true });
                });
        });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

// Mesajları al (aktif odadan)
app.post('/messages', (req, res) => {
    const { username, token } = req.body;
    
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        db.get('SELECT current_room FROM user_room WHERE username = ?', [username], (err, room) => {
            if(!room || !room.current_room) {
                return res.json([]);
            }
            
            db.all('SELECT * FROM room_messages WHERE room_code = ? ORDER BY timestamp DESC LIMIT 100',
                [room.current_room], (err, rows) => {
                    res.json(rows);
                });
        });
    } catch(e) {
        res.status(401).json({ error: 'Yetkisiz!' });
    }
});

app.listen(3000, () => console.log('🔥 ODA SİSTEMİ AKTİF! http://localhost:3000'));
