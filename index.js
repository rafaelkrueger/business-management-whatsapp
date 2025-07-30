const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const axios = require('axios');
const mime = require('mime-types');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });
const upload = multer({ dest: 'uploads/' });

const TOKEN_DIR = path.join(__dirname, 'tokens');
const sessions = {};
const qrCodes = {};
const tokenTimers = {};

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('frontend'));

const cleanPhoneNumber = (number) => number.replace(/[^\d]/g, '') + '@c.us';
const removeSessionData = (sessionName) => {
  if (sessions[sessionName]) sessions[sessionName].close();
  delete sessions[sessionName];
  delete qrCodes[sessionName];
  delete tokenTimers[sessionName];

  const sessionPath = path.join(TOKEN_DIR, sessionName);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`⚠️ Arquivos de ${sessionName} em uso, não removidos.`);
    }
  }
};

async function initSession(sessionName) {
  if (sessions[sessionName]) return;

  const client = await wppconnect.create({
    session: sessionName,
    sessionPath: TOKEN_DIR,
    catchQR: (qr) => {
      qrCodes[sessionName] = qr;
      io.emit(`qr-${sessionName}`, qr);
    },
    statusFind: async (status) => {
      if (['isLogged', 'inChat'].includes(status)) {
        clearTimeout(tokenTimers[sessionName]);
        await axios.post('https://core.roktune.com/whatsapp/connected', { sessionName, status: true });
      } else if (status === 'notLogged') {
        await axios.post('https://core.roktune.com/whatsapp/disconnected', { sessionName, status: true });
        removeSessionData(sessionName);
      }
    },
    headless: true,
    puppeteerOptions: {
      executablePath: '/usr/bin/chromium-browser',
      args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--single-process'],
    },
    autoClose: false,
    disableWelcome: true,
    logLevel: 'error',
  });

  sessions[sessionName] = client;

  client.onMessage(async (message) => {
  const session = sessions[sessionName];
  const cleanNumber = cleanPhoneNumber(message.chatId);

  if (!message.isGroupMsg) {
    try {
      await session.startTyping(cleanNumber);

      const res = await axios.post(`https://core.roktune.com/whatsapp/chatbot`, {
        from: message.from,
        message: message.content,
        sessionName: sessionName,
      });

      const data = res.data;
      if (!Array.isArray(data) && typeof data === 'object') {
        const keys = Object.keys(data).filter((key) => !isNaN(Number(key)));

        if (keys.length > 0) {
          for (const key of keys) {
            const item = data[key];
            if (!item?.reply) continue;

            if (item.isImage) {
              await session.sendImage(cleanNumber, item.reply, 'image', '');
            } else if (item.isDocument) {
              await session.sendFile(cleanNumber, item.reply, 'file');
            } else {
              await session.sendText(cleanNumber, item.reply);
            }
          }
        }
      }

      if (data && data.reply) {
        if (data.isImage) {
          await session.sendImage(cleanNumber, data.reply, 'image', '');
        } else if (data.isDocument) {
          await session.sendFile(cleanNumber, data.reply, 'file');
        } else {
          await session.sendText(cleanNumber, data.reply);
        }
      }

    } catch (err) {
      console.error(`[${sessionName}] ❌ Erro ao enviar mensagem para /chatbot`, err.message);
    } finally {
      await session.stopTyping(cleanNumber);
    }
  }
});
}

function loadSavedSessions() {
  if (fs.existsSync(TOKEN_DIR)) {
    const sessionsDir = fs.readdirSync(TOKEN_DIR, { withFileTypes: true }).filter(f => f.isDirectory()).map(f => f.name);
    sessionsDir.forEach((session) => initSession(session));
  }
}

app.post('/session/:name', async (req, res) => {
  const sessionName = req.params.name;
  if (sessions[sessionName]){
    return res.status(400).json({ error: 'Sessão já existe.' })
  };
  initSession(sessionName);
  res.status(201).json({ message: `Sessão ${sessionName} criada.` });
});


app.post('/send-message', upload.single('image'), async (req, res) => {
  const { sessionName, phone, message } = req.body;
  const file = req.file;

  if (!sessionName || !phone || (!message && !file)) {
    return res.status(400).json({ error: 'sessionName, phone e message/image são obrigatórios.' });
  }

  const session = sessions[sessionName];
  if (!session) return res.status(404).json({ error: `Session ${sessionName} não encontrada.` });

  const phoneList = Array.isArray(phone) ? phone : [phone];
  const results = [];

  for (const number of phoneList) {
    const cleanNumber = cleanPhoneNumber(number);

    try {
      let result;
      if (file) {
        const extension = mime.extension(file.mimetype) || 'jpg';
        const filePath = file.path;
        result = await session.sendImage(cleanNumber, filePath, `image.${extension}`, message || '');
        fs.unlinkSync(filePath);
        console.log(`📸 Imagem enviada para ${cleanNumber}`);
      } else {
        result = await session.sendText(cleanNumber, message);
        console.log(`✅ Mensagem enviada para ${cleanNumber}`);
      }
      results.push({ number: cleanNumber, success: true, result });
    } catch (error) {
      console.error(`❌ Erro ao enviar para ${cleanNumber}:`, error);
      results.push({ number: cleanNumber, success: false, error: error.message });
    }
  }

  res.status(200).json({ success: true, results });
});

app.get('/qrcode/:name', (req, res) => {
  const sessionName = req.params.name;
  if (!qrCodes[sessionName]) return res.status(404).json({ error: 'QR Code não disponível.' });
  res.status(200).json({ qrCode: qrCodes[sessionName] });
});

server.listen(4000, () => {
  loadSavedSessions();
  console.log('🚀 Servidor rodando em http://localhost:4000');
});
