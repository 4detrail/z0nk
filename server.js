const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// JSON dosya tabanlı veritabanı
let users = [];
let rooms = [];
let messages = [];
let userRooms = [];

// Veri dosyalarını yükle
const loadData = () => {
    try {
        if(fs.existsSync('users.json')) users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        if(fs.existsSync('rooms.json')) rooms = JSON.parse(fs.readFileSync('rooms.json', 'utf8'));
        if(fs.existsSync('messages.json')) messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        if(fs.existsSync('userRooms.json')) userRooms = JSON.parse(fs.readFileSync('userRooms.json', 'utf8'));
    } catch(e) {}
};

const saveData = () => {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
    fs.writeFileSync('rooms.json', JSON.stringify(rooms, null, 2));
    fs.writeFileSync('messages.json', JSON.stringify(messages, null, 2));
    fs.writeFileSync('userRooms.json', JSON.stringify(userRooms, null, 2));
};

loadData();

// Oda kodu üretici
function generateRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '#';
    for(let i = 0; i < 2; i++) code += letters[Math.floor(Math.random() * letters.length)];
    for(let i = 0; i < 3; i++) code += numbers[Math.floor(Math.random() * numbers.length)];
    return code;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Kayıt
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli!' });
    
    if(users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı var!' });
    
    const hashed = await bcrypt.hash(password, 10);
    users.push({ username, password: hashed, created_at: new Date().toISOString() });
    saveData();
    res.json({ success: true });
});

// Giriş
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if(!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı!' });
    
    const validPass = await bcrypt.compare(password, user.password);
    if(!validPass) return res.status(401).json({ error: 'Hatalı şifre!' });
    
    const token = jwt.sign({ username }, 'GIZLI_ANAHTAR', { expiresIn: '24h' });
    res.json({ token, username });
});

// Oda oluştur
app.post('/create_room', async (req, res) => {
    const { username, room_name, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        let room_code;
        do { room_code = generateRoomCode(); } while(rooms.find(r => r.room_code === room_code));
        
        rooms.push({ room_code, room_name, created_by: username, created_at: new Date().toISOString() });
        saveData();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Odaya katıl
app.post('/join_room', (req, res) => {
    const { username, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        if(!rooms.find(r => r.room_code === room_code)) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        const idx = userRooms.findIndex(u => u.username === username);
        if(idx !== -1) userRooms[idx].current_room = room_code;
        else userRooms.push({ username, current_room: room_code });
        saveData();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Aktif oda
app.post('/current_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        res.json({ room_code: ur ? ur.current_room : null });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Odaları listele
app.post('/list_rooms', (req, res) => {
    const { token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        res.json(rooms);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Mesaj gönder
app.post('/send', (req, res) => {
    const { from, message, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === from);
        if(!ur || !ur.current_room) return res.status(400).json({ error: 'Önce bir odaya katılın!' });
        
        messages.push({ room_code: ur.current_room, from_user: from, message, timestamp: new Date().toISOString() });
        if(messages.length > 500) messages = messages.slice(-500);
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Mesajları al
app.post('/messages', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        if(!ur || !ur.current_room) return res.json([]);
        
        const roomMessages = messages.filter(m => m.room_code === ur.current_room).slice(-100);
        res.json(roomMessages);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`\n✅ ODA SİSTEMİ AKTİF!`);
    console.log(`📍 http://localhost:${PORT}`);
});
