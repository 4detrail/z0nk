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
let userActivity = {};

// Veri dosyalarını yükle
const loadData = () => {
    try {
        if(fs.existsSync('users.json')) users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        if(fs.existsSync('rooms.json')) rooms = JSON.parse(fs.readFileSync('rooms.json', 'utf8'));
        if(fs.existsSync('messages.json')) messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        if(fs.existsSync('userRooms.json')) userRooms = JSON.parse(fs.readFileSync('userRooms.json', 'utf8'));
        if(fs.existsSync('userActivity.json')) userActivity = JSON.parse(fs.readFileSync('userActivity.json', 'utf8'));
    } catch(e) {}
};

const saveData = () => {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
    fs.writeFileSync('rooms.json', JSON.stringify(rooms, null, 2));
    fs.writeFileSync('messages.json', JSON.stringify(messages, null, 2));
    fs.writeFileSync('userRooms.json', JSON.stringify(userRooms, null, 2));
    fs.writeFileSync('userActivity.json', JSON.stringify(userActivity, null, 2));
};

loadData();

// ============ OTOMATİK MESAJ SİLME (20 dakika) ============
setInterval(() => {
    const now = new Date();
    const twentyMinsAgo = new Date(now.getTime() - 20 * 60 * 1000);
    const beforeCount = messages.length;
    
    messages = messages.filter(msg => {
        const msgDate = new Date(msg.timestamp);
        return msgDate > twentyMinsAgo;
    });
    
    if (messages.length !== beforeCount) {
        console.log(`🗑️ ${beforeCount - messages.length} eski mesaj silindi (20 dakika)`);
        saveData();
    }
}, 60 * 1000);

// ============ AFK kontrolü (10 dakika) ============
setInterval(() => {
    const now = Date.now();
    for (const [username, lastActive] of Object.entries(userActivity)) {
        if (now - lastActive > 10 * 60 * 1000) {
            const idx = userRooms.findIndex(u => u.username === username);
            if (idx !== -1) {
                const room = rooms.find(r => r.room_code === userRooms[idx].current_room);
                if (room && room.users) {
                    const userIdx = room.users.indexOf(username);
                    if (userIdx !== -1) room.users.splice(userIdx, 1);
                }
                userRooms.splice(idx, 1);
                console.log(`🗑️ ${username} AFK olduğu için odadan atıldı`);
            }
            delete userActivity[username];
            saveData();
        }
    }
}, 60 * 1000);

// ============ Oda kodu üretici ============
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

// ============ KULLANICILAR ============

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli!' });
    
    if(users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı var!' });
    
    const hashed = await bcrypt.hash(password, 10);
    users.push({ username, password: hashed, created_at: new Date().toISOString() });
    saveData();
    res.json({ success: true });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if(!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı!' });
    
    const validPass = await bcrypt.compare(password, user.password);
    if(!validPass) return res.status(401).json({ error: 'Hatalı şifre!' });
    
    const token = jwt.sign({ username }, 'GIZLI_ANAHTAR', { expiresIn: '24h' });
    userActivity[username] = Date.now();
    saveData();
    res.json({ token, username });
});

app.post('/update_activity', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        userActivity[username] = Date.now();
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ ODALAR ============

app.post('/create_room', async (req, res) => {
    const { username, room_name, room_password, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        let room_code;
        do { room_code = generateRoomCode(); } while(rooms.find(r => r.room_code === room_code));
        
        const hashedPassword = room_password ? await bcrypt.hash(room_password, 10) : null;
        
        rooms.push({ 
            room_code, 
            room_name, 
            room_password: hashedPassword,
            created_by: username, 
            created_at: new Date().toISOString(),
            users: [username]
        });
        saveData();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/join_room', async (req, res) => {
    const { username, room_code, room_password, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        if (room.room_password) {
            if (!room_password) return res.status(401).json({ error: 'Bu oda şifreli! Şifre girin!' });
            const valid = await bcrypt.compare(room_password, room.room_password);
            if (!valid) return res.status(401).json({ error: 'Oda şifresi hatalı!' });
        }
        
        const idx = userRooms.findIndex(u => u.username === username);
        if(idx !== -1) userRooms[idx].current_room = room_code;
        else userRooms.push({ username, current_room: room_code });
        
        if (!room.users.includes(username)) room.users.push(username);
        
        userActivity[username] = Date.now();
        saveData();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ODAYI SİL (tüm mesajlarıyla birlikte)
app.post('/delete_room', (req, res) => {
    const { username, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        if (room.created_by !== username) {
            return res.status(403).json({ error: 'Bu odayı sadece oluşturan kişi silebilir!' });
        }
        
        // Odadaki TÜM mesajları sil
        const deletedMsgCount = messages.filter(m => m.room_code === room_code).length;
        messages = messages.filter(m => m.room_code !== room_code);
        
        // Odadaki tüm kullanıcıları userRooms'dan temizle
        for (const user of room.users) {
            const urIdx = userRooms.findIndex(u => u.username === user && u.current_room === room_code);
            if (urIdx !== -1) userRooms.splice(urIdx, 1);
        }
        
        // Odayı sil
        const roomIdx = rooms.findIndex(r => r.room_code === room_code);
        rooms.splice(roomIdx, 1);
        
        console.log(`🗑️ Oda ${room_code} silindi, ${deletedMsgCount} mesaj temizlendi`);
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/current_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        res.json({ room_code: ur ? ur.current_room : null });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/leave_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        const urIdx = userRooms.findIndex(u => u.username === username);
        if (urIdx !== -1) {
            const roomCode = userRooms[urIdx].current_room;
            const room = rooms.find(r => r.room_code === roomCode);
            if (room) {
                const userIdx = room.users.indexOf(username);
                if (userIdx !== -1) room.users.splice(userIdx, 1);
            }
            userRooms.splice(urIdx, 1);
        }
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/list_rooms', (req, res) => {
    const { token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const publicRooms = rooms.map(r => ({
            room_code: r.room_code,
            room_name: r.room_name,
            created_by: r.created_by,
            is_locked: !!r.room_password,
            users_count: r.users ? r.users.filter(u => userActivity[u] && (Date.now() - userActivity[u] < 10 * 60 * 1000)).length : 0,
            total_users: r.users ? r.users.length : 0,
            message_count: messages.filter(m => m.room_code === r.room_code).length
        }));
        res.json(publicRooms);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/room_users', (req, res) => {
    const { room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.json([]);
        
        const activeUsers = room.users.filter(u => userActivity[u] && (Date.now() - userActivity[u] < 10 * 60 * 1000));
        res.json(activeUsers);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ MESAJLAR ============

app.post('/send', (req, res) => {
    const { from, message, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === from);
        if(!ur || !ur.current_room) return res.status(400).json({ error: 'Önce bir odaya katılın!' });
        
        const room = rooms.find(r => r.room_code === ur.current_room);
        if (!room) {
            return res.status(400).json({ error: 'Oda silinmiş!' });
        }
        
        userActivity[from] = Date.now();
        messages.push({ 
            room_code: ur.current_room, 
            from_user: from, 
            message, 
            timestamp: new Date().toISOString() 
        });
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/messages', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        if(!ur || !ur.current_room) return res.json([]);
        
        userActivity[username] = Date.now();
        
        // SADECE kullanıcının aktif odasındaki mesajları getir (en eski mesajlar önce)
        const roomMessages = messages
            .filter(m => m.room_code === ur.current_room)
            .slice(-100);
        
        res.json(roomMessages);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/logout', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const idx = userRooms.findIndex(u => u.username === username);
        if (idx !== -1) {
            const room = rooms.find(r => r.room_code === userRooms[idx].current_room);
            if (room) {
                const userIdx = room.users.indexOf(username);
                if (userIdx !== -1) room.users.splice(userIdx, 1);
            }
            userRooms.splice(idx, 1);
        }
        delete userActivity[username];
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🔥 HEXAHACK IAIM CHAT SİSTEMİ AKTİF!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`⏰ Mesajlar 20 dakika sonra otomatik silinecek`);
    console.log(`🗑️ AFK kullanıcılar 10 dakika sonra atılacak`);
});
