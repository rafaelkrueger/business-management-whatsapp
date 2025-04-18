const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const mime = require('mime-types');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const io = socketIO(server, {
  cors: {
    origin: '*',
  },
});

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('frontend'));

const sessions = {};
const qrCodes = {};
const tokenTimers = {};
const TOKEN_DIR = path.join(__dirname, 'tokens');

async function initSession(sessionName) {
  if (sessions[sessionName]) return;

  wppconnect
    .create({
      session: sessionName,
      sessionPath: TOKEN_DIR,
      catchQR: (base64Qrimg, asciiQR, attempts, urlCode) => {
        qrCodes[sessionName] = base64Qrimg;
        io.emit(`qr-${sessionName}`, base64Qrimg);

        if (tokenTimers[sessionName]) clearTimeout(tokenTimers[sessionName]);
        tokenTimers[sessionName] = setTimeout(() => {
          console.log(`⏱️ Sessão ${sessionName} expirou por inatividade.`);

          if (sessions[sessionName]) {
            sessions[sessionName].close();
            delete sessions[sessionName];
          }

          delete qrCodes[sessionName];
          delete tokenTimers[sessionName];

          const sessionPath = path.join(TOKEN_DIR, sessionName);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🧹 Tokens da sessão ${sessionName} removidos.`);
          }
        }, 60000);
      },
      statusFind: async (status) => {
        console.log(`🟢 Sessão ${sessionName} status: ${status}`);
        if (status === 'isLogged' || status === 'inChat') {
          if (tokenTimers[sessionName]) {
            clearTimeout(tokenTimers[sessionName]);
            delete tokenTimers[sessionName];
          }
          await axios.post('https://roktune.duckdns.org//whatsapp/connected', {
            sessionName,
            status: true,
          });
          console.log(`📡 Notificação enviada para /whatsapp/connected`);
        }else if (status === 'notLogged'){
          await axios.post('https://roktune.duckdns.org//whatsapp/disconnected', {
            sessionName,
            status: true,
          });
          console.log(`📡 Notificação enviada para /whatsapp/disconnected`);

          // Fecha e remove a sessão da memória
          if (sessions[sessionName]) {
            await sessions[sessionName].close();
            delete sessions[sessionName];
          }

          // Remove QR code e timer
          delete qrCodes[sessionName];
          if (tokenTimers[sessionName]) {
            clearTimeout(tokenTimers[sessionName]);
            delete tokenTimers[sessionName];
          }

          // Remove tokens da pasta
          const sessionPath = path.join(TOKEN_DIR, sessionName);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`🧹 Tokens for ${sessionName} removed due to notLogged`);
          }
        }
      },
      headless: true,
      puppeteerOptions: {
        executablePath: '/usr/bin/chromium-browser',
        args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--single-process',
          ],
      },
      autoClose: false,
      disableWelcome: true,
    })
    .then((client) => {
      sessions[sessionName] = client;

      client.onMessage(async (message) => {
        console.log(`[${sessionName}] Nova mensagem de ${message.from}: ${message.body}`);
      });
    })
    .catch((err) => {
      console.error(`❌ Erro ao iniciar sessão ${sessionName}:`, err);
    });
}

function loadSavedSessions() {
  if (!fs.existsSync(TOKEN_DIR)) return;

  const sessionFolders = fs.readdirSync(TOKEN_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  sessionFolders.forEach((sessionName) => {
    console.log(`🔄 Restaurando sessão ${sessionName}...`);
    initSession(sessionName);
  });
}

app.post('/session/:name', async (req, res) => {
  const sessionName = req.params.name;

  if (sessions[sessionName]) {
    return res.status(400).json({ error: 'Sessão já existe.' });
  }

  await initSession(sessionName);
  res.status(201).json({ message: `Sessão ${sessionName} criada` });
});

app.post('/send-message', upload.single('image'), async (req, res) => {
  const { sessionName, phone, message } = req.body;
  const file = req.file;

  if (!sessionName || !phone || (!message && !file)) {
    return res.status(400).json({ error: 'sessionName, phone, and either message or image are required.' });
  }

  const session = sessions[sessionName];
  if (!session) {
    return res.status(404).json({ error: `Session ${sessionName} not found or not connected.` });
  }

  const phoneList = Array.isArray(phone) ? phone : [phone];
  const results = [];

  for (const number of phoneList) {
    const cleanNumber = number.replace(/[^\d]/g, '') + '@c.us';

    try {
      let result;
      if (file) {
        const extension = mime.extension(file.mimetype) || 'jpg';
        const filePath = file.path;
        result = await session.sendImage(cleanNumber, filePath, `image.${extension}`, message || '');
        fs.unlinkSync(filePath);
        console.log(`📸 Image sent to ${cleanNumber}`);
      } else {
        result = await session.sendText(cleanNumber, message);
        console.log(`✅ Message sent to ${cleanNumber}`);
      }

      results.push({ number: cleanNumber, success: true, result });
    } catch (error) {
      console.error(`❌ Failed to send to ${cleanNumber}:`, error);
      results.push({ number: cleanNumber, success: false, error: error });
    }
  }

  return res.status(200).json({ success: true, results });
});

app.get('/qrcode/:name', (req, res) => {
  const sessionName = req.params.name;

  const qr = qrCodes[sessionName];
  if (!qr) {
    return res.status(404).json({ error: 'QR Code não disponível. A sessão pode já estar conectada.' });
  }

  return res.status(200).json({ qrCode: qr });
});

server.listen(4000, () => {
  console.log('🚀 Servidor rodando em http://localhost:4000');
  loadSavedSessions();
});
