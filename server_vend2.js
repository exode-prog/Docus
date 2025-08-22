//Les importations
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { createCanvas } = require('canvas');
const axios = require('axios');
const moment = require('moment');
moment.locale('fr');

const SECRET_KEY = 'passer123!';
const app = express();

//gestion des fichiers
const multer = require('multer');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.params.sessionId;
    if (!sessionId) return cb(new Error('Session ID manquant'));
    const dir = path.join(__dirname, 'uploads', `session_${sessionId}`);
    fs.mkdir(dir, { recursive: true }, err => cb(err, dir));
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);  // Attention aux doublons en production!
  }
});

const upload = multer({ storage });

const studentInfoCache = new Map();

// Charger les certificats HTTPS
const options = {
    key: fs.readFileSync(path.join(__dirname, 'mes_certificats', 'localhost-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'mes_certificats', 'localhost.pem'))
};

// Créer le serveur HTTPS avec Express
const server = https.createServer(options, app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  user: 'postgres',
  host: '192.168.1.39',
  database: 'hbbtv',
  password: 'passer',
  port: 5432,
});

// -- Déclarations globales --
const tvSockets = new Map();               // tokenQR => socket TV
const sessionClients = new Map();          // tokenQR => Set() sockets étudiants + prof
const sessionRooms = new Map();            // sessionId => Set() sockets pour WebRTC
const questionsBySession = new Map();      // tokenQR => Array questions sourdines
const raisedHandsMap = new Map();          // tokenQR => Map(userId => user)
const currentSpeaker = new Map();          // tokenQR => { type: 'teacher'|'student', studentId, socketId }

// Variables pour notes partagées
const sharedNotesContent = new Map();      // tokenQR => contenu HTML des notes
const notesCollaborators = new Map();      // tokenQR => Set() utilisateurs autorisés à écrire
const notesActiveEditors = new Map();      // tokenQR => Map(socketId => user)

// Variables pour documents de cours
const sessionDocuments = new Map();        // tokenQR => Array documents
const sessionAttendance = new Map();       // tokenQR => Map(userId => {user, joinTime, leaveTime})

// Middleware auth JWT pour Express
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token manquant' });

  const token = authHeader.split(' ')[1];
  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token invalide ou expiré' });
    req.user = user;
    next();
  });
}

// Alias pour compatibilité
const authenticateToken = authMiddleware;

// Fonction pour créer les dossiers de session
function ensureSessionDirectory(tokenQR) {
  const sessionDir = path.join(__dirname, 'sessions', tokenQR);
  const docsDir = path.join(sessionDir, 'documents');
  const notesDir = path.join(sessionDir, 'notes');
  const attendanceDir = path.join(sessionDir, 'attendance');
  
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(attendanceDir, { recursive: true });
  
  return { sessionDir, docsDir, notesDir, attendanceDir };
}

// Fonction pour générer un PDF de notes partagées
async function generateNotesPDF(tokenQR, content) {
  try {
    const { notesDir } = ensureSessionDirectory(tokenQR);
    const date = moment().format('DD-MM-YYYY');
    const filename = `Notes_partagees_du_${date}.pdf`;
    const filePath = path.join(notesDir, filename);
    
    // Créer un nouveau document PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    
    // Ajouter le contenu
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 12;
    
    // Titre
    page.drawText(`Notes partagées du ${date}`, {
      x: 50,
      y: height - 50,
      size: 18,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Contenu (simplifié - en production, utiliser une bibliothèque HTML-to-PDF)
    const textContent = content.replace(/<[^>]*>/g, ''); // Enlever les balises HTML
    const lines = textContent.split('\n');
    let y = height - 100;
    
    for (const line of lines) {
      if (y < 50) {
        // Ajouter une nouvelle page si nécessaire
        const newPage = pdfDoc.addPage([595.28, 841.89]);
        y = height - 50;
      }
      
      page.drawText(line, {
        x: 50,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
      
      y -= fontSize * 1.5;
    }
    
    // Enregistrer le PDF
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(filePath, pdfBytes);
    
    return filePath;
  } catch (error) {
    console.error('Erreur génération PDF notes:', error);
    return null;
  }
}

// Fonction pour générer un résumé des notes avec IA
async function generateNotesSummary(tokenQR, content) {
  try {
    const { notesDir } = ensureSessionDirectory(tokenQR);
    const date = moment().format('DD-MM-YYYY');
    const filename = `Resume_des_notes_partagees_du_${date}.pdf`;
    const filePath = path.join(notesDir, filename);
    
    // Simplifier le contenu HTML
    const textContent = content.replace(/<[^>]*>/g, '');
    
    // Appel à l'API OpenAI pour résumer
    // Note: Remplacer par votre clé API réelle en production
    const apiKey = process.env.OPENAI_API_KEY || 'sk-proj-your-api-key-here';
    
    let summary = textContent;
    
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'system',
              content: 'Tu es un assistant spécialisé dans la création de résumés académiques. Résume le texte fourni en conservant les points clés et les concepts importants. Organise le résumé avec des titres et sous-titres si nécessaire.'
            },
            {
              role: 'user',
              content: textContent
            }
          ],
          max_tokens: 1000
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      summary = response.data.choices[0].message.content;
    } catch (apiError) {
      console.error('Erreur API OpenAI:', apiError);
      summary = `Résumé automatique indisponible. Voici le contenu original:\n\n${textContent}`;
    }
    
    // Créer un nouveau document PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    
    // Ajouter le contenu
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 12;
    
    // Titre
    page.drawText(`Résumé des notes partagées du ${date}`, {
      x: 50,
      y: height - 50,
      size: 18,
      font,
      color: rgb(0, 0, 0),
    });
    
    // Contenu du résumé
    const summaryLines = summary.split('\n');
    let y = height - 100;
    
    for (const line of summaryLines) {
      if (y < 50) {
        // Ajouter une nouvelle page si nécessaire
        const newPage = pdfDoc.addPage([595.28, 841.89]);
        y = height - 50;
      }
      
      page.drawText(line, {
        x: 50,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
      
      y -= fontSize * 1.5;
    }
    
    // Enregistrer le PDF
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(filePath, pdfBytes);
    
    return { filePath, summary };
  } catch (error) {
    console.error('Erreur génération résumé notes:', error);
    return null;
  }
}

// Fonction pour générer un PDF de liste de présence
async function generateAttendancePDF(tokenQR) {
  try {
    const { attendanceDir } = ensureSessionDirectory(tokenQR);
    const date = moment().format('DD-MM-YYYY');
    const filename = `Liste_des_presences_du_${date}.pdf`;
    const filePath = path.join(attendanceDir, filename);
    
    // Récupérer les données de présence
    const attendanceData = sessionAttendance.get(tokenQR) || new Map();
    
    // Créer un nouveau document PDF
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    
    // Ajouter le contenu
    const { width, height } = page.getSize();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 12;
    
    // Titre
    page.drawText(`Liste des présences du ${date}`, {
      x: 50,
      y: height - 50,
      size: 18,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    
    // En-têtes
    let y = height - 100;
    page.drawText('Nom', { x: 50, y, size: fontSize, font: boldFont });
    page.drawText('Prénom', { x: 150, y, size: fontSize, font: boldFont });
    page.drawText('Heure d\'arrivée', { x: 250, y, size: fontSize, font: boldFont });
    page.drawText('Heure de départ', { x: 400, y, size: fontSize, font: boldFont });
    
    y -= 20;
    
    // Liste des étudiants
    for (const [userId, data] of attendanceData.entries()) {
      if (y < 50) {
        // Ajouter une nouvelle page si nécessaire
        const newPage = pdfDoc.addPage([595.28, 841.89]);
        y = height - 50;
      }
      
      const { user, joinTime, leaveTime } = data;
      const joinTimeFormatted = moment(joinTime).format('HH:mm:ss');
      const leaveTimeFormatted = leaveTime ? moment(leaveTime).format('HH:mm:ss') : 'En cours';
      
      page.drawText(user.nom || 'N/A', { x: 50, y, size: fontSize, font });
      page.drawText(user.prenom || 'N/A', { x: 150, y, size: fontSize, font });
      page.drawText(joinTimeFormatted, { x: 250, y, size: fontSize, font });
      page.drawText(leaveTimeFormatted, { x: 400, y, size: fontSize, font });
      
      y -= fontSize * 1.5;
    }
    
    // Enregistrer le PDF
    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync(filePath, pdfBytes);
    
    return filePath;
  } catch (error) {
    console.error('Erreur génération PDF présence:', error);
    return null;
  }
}

// Middleware pour autoriser les rôles
function authorizeRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'Accès interdit : rôle incorrect' });
    }
    next();
  };
}

// Middleware pour autoriser l'accès à une session
async function authorizeSessionAccess(req, res, next) {
  const user = req.user;
  const sessionId = req.params.sessionId;

  try {
    let hasAccess = false;

    if (user.role === 'admin' || user.role === 'enseignant') {
      hasAccess = true;
    } else if (user.role === 'etudiant') {
      const result = await pool.query(
        'SELECT 1 FROM logins l WHERE l.session_id = $1 AND l.user_id = $2 AND l.date_logout IS NULL',
        [sessionId, user.id]
      );
      hasAccess = result.rowCount > 0;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: 'Accès refusé à cette session' });
    }

    next();

  } catch (err) {
    console.error('Erreur vérification accès session:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

// ==========================================
// GESTION DES ÉVÉNEMENTS SOCKET.IO OPTIMISÉE
// ==========================================
io.on('connection', socket => {
  console.log('[SERVER] Socket connecté:', socket.id);

  // Stockage userId côté socket pour identification
  socket.on('auth_user', data => {
    if (data && data.user && data.user.id) {
      socket.userId = data.user.id;
      socket.userData = data.user;
      console.log(`[SERVER] Socket ${socket.id} authentifié avec userId ${socket.userId}`);
      
      // Enregistrer la présence si dans une session
      if (socket.sessionToken && socket.userData) {
        if (!sessionAttendance.has(socket.sessionToken)) {
          sessionAttendance.set(socket.sessionToken, new Map());
        }
        
        sessionAttendance.get(socket.sessionToken).set(socket.userId, {
          user: socket.userData,
          joinTime: new Date(),
          leaveTime: null
        });
        
        // Créer les dossiers de session si nécessaire
        ensureSessionDirectory(socket.sessionToken);
      }
    }
  });

  // Gestion des sessions WebRTC
  socket.on('joinSession', (data) => {
    const { sessionId, role } = data;
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role = role;
    
    if (!sessionRooms.has(sessionId)) {
      sessionRooms.set(sessionId, new Set());
    }
    sessionRooms.get(sessionId).add(socket);
    
    console.log(`[SERVER] ${role} ${socket.id} rejoint session ${sessionId}`);
  });

  // Enregistrement du socket TV par tokenQR
  socket.on('register_session', tokenQR => {
    tvSockets.set(tokenQR, socket);
    socket.tokenQR = tokenQR;
    console.log(`[SERVER] 📺 TV enregistrée pour session ${tokenQR}, Socket ID: ${socket.id}`);
    
    socket.emit('tv_registered', {
      tokenQR: tokenQR,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });
    
    // Créer les dossiers de session si nécessaire
    ensureSessionDirectory(tokenQR);
  });

  // Rejoindre une session (étudiant ou prof)
  socket.on('join_session', tokenQR => {
    if (!sessionClients.has(tokenQR)) sessionClients.set(tokenQR, new Set());
    sessionClients.get(tokenQR).add(socket);
    socket.sessionToken = tokenQR;
    console.log(`[SERVER] Socket ${socket.id} rejoint session ${tokenQR} (clients: ${sessionClients.get(tokenQR).size})`);
    
    // Enregistrer la présence si l'utilisateur est authentifié
    if (socket.userData) {
      if (!sessionAttendance.has(tokenQR)) {
        sessionAttendance.set(tokenQR, new Map());
      }
      
      sessionAttendance.get(tokenQR).set(socket.userId, {
        user: socket.userData,
        joinTime: new Date(),
        leaveTime: null
      });
      
      // Créer les dossiers de session si nécessaire
      ensureSessionDirectory(tokenQR);
    }
    
    // Mettre à jour le compteur d'étudiants
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      const studentCount = [...clients].filter(s => s.userData?.role === 'etudiant').length;
      
      clients.forEach(s => {
        s.emit('students_count_update', { count: studentCount });
      });
      
      // Informer la TV
      const tvSocket = tvSockets.get(tokenQR);
      if (tvSocket) {
        tvSocket.emit('students_count_update', { count: studentCount });
      }
    }
  });

  // Enregistrement TV display amélioré
  socket.on('register_tv_display', (data) => {
    console.log('[SERVER] 📺 Enregistrement TV Display:', data);

    if (data.tokenQR) {
      tvSockets.set(data.tokenQR, socket);
      socket.tokenQR = data.tokenQR;
      socket.tvType = data.type || 'qr_display';
      socket.userData = data.user;

      console.log(`[SERVER] ✅ TV Display confirmée pour ${data.tokenQR}, utilisateur: ${data.user?.prenom} ${data.user?.nom}`);
      
      socket.emit('tv_registered', {
        tokenQR: data.tokenQR,
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
      
      // Créer les dossiers de session si nécessaire
      ensureSessionDirectory(data.tokenQR);
    }
  });

  // CORRECTION PRINCIPALE : Gestion user_logged_in améliorée
  socket.on('user_logged_in', (data) => {
    console.log('[SERVER] Événement user_logged_in reçu:', data);
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données user_logged_in invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // 1. DIFFUSION VERS TV SPÉCIFIQUE (PRIORITÉ)
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket && tvSocket.id !== socket.id) {
      console.log('[SERVER] 📺 Envoi user_logged_in vers TV:', tvSocket.id);
      
      tvSocket.emit('user_logged_in', {
        id: data.id,
        prenom: data.prenom,
        nom: data.nom,
        role: data.role,
        email: data.email,
        tokenQR: tokenQR,
        timestamp: data.timestamp || new Date().toISOString(),
        source: data.source || 'phone'
      });
      
      console.log('[SERVER] ✅ TV notifiée du login utilisateur');
    } else {
      console.log('[SERVER] ⚠️ Aucune TV trouvée pour tokenQR:', tokenQR);
    }
    
    // 2. Diffusion vers tous les clients de la session
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(clientSocket => {
        if (clientSocket.id !== socket.id) {
          clientSocket.emit('user_logged_in', data);
        }
      });
      console.log(`[SERVER] user_logged_in diffusé à ${clients.size} clients`);
    }
    
    // 3. Confirmer réception au socket émetteur
    socket.emit('user_logged_in_acknowledged', {
      userId: data.id,
      tokenQR: data.tokenQR,
      timestamp: new Date().toISOString(),
      tvNotified: !!tvSocket
    });
    
    console.log('[SERVER] Confirmation user_logged_in envoyée à émetteur');
    
    // 4. Enregistrer la présence
    if (data.id) {
      if (!sessionAttendance.has(tokenQR)) {
        sessionAttendance.set(tokenQR, new Map());
      }
      
      sessionAttendance.get(tokenQR).set(data.id, {
        user: {
          id: data.id,
          prenom: data.prenom,
          nom: data.nom,
          role: data.role,
          email: data.email
        },
        joinTime: new Date(),
        leaveTime: null
      });
    }
  });

  // Événement de déconnexion utilisateur
  socket.on('user_logged_out', (data) => {
    console.log('[SERVER] Événement user_logged_out reçu:', data);
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données user_logged_out invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // 1. Mettre à jour l'heure de départ dans la liste de présence
    if (data.userId && sessionAttendance.has(tokenQR)) {
      const attendanceMap = sessionAttendance.get(tokenQR);
      if (attendanceMap.has(data.userId)) {
        const record = attendanceMap.get(data.userId);
        record.leaveTime = new Date();
        attendanceMap.set(data.userId, record);
      }
    }
    
    // 2. Diffuser l'événement à tous les clients de la session
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(clientSocket => {
        if (clientSocket.id !== socket.id) {
          clientSocket.emit('user_logged_out', data);
        }
      });
    }
    
    // 3. Informer la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('user_logged_out', data);
    }
    
    // 4. Mettre à jour le compteur d'étudiants
    if (clients) {
      const studentCount = [...clients].filter(s => 
        s.userData?.role === 'etudiant' && 
        s.id !== socket.id
      ).length;
      
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('students_count_update', { count: studentCount });
        }
      });
      
      if (tvSocket) {
        tvSocket.emit('students_count_update', { count: studentCount });
      }
    }
  });

  // ==========================================
  // ÉVÉNEMENTS WEBRTC HARMONISÉS - CORRIGÉS
  // ==========================================

  // --- 1. DIFFUSION ENSEIGNANT → ÉTUDIANTS ---
  
  // Enseignant démarre diffusion (offer broadcast vers tous les étudiants)
  socket.on('teacher-broadcast-offer', data => {
    const { sessionId, tokenQR, offer } = data;
    console.log('[SERVER] Enseignant démarre diffusion pour session:', sessionId);
    
    // Diffuser à tous les étudiants de la session
    if (sessionId && sessionRooms.has(sessionId)) {
      sessionRooms.get(sessionId).forEach(s => {
        if (s !== socket && s.role === 'student') {
          s.emit('teacher-broadcast-offer', { offer, tokenQR });
          console.log('[SERVER] Offre broadcast envoyée à étudiant:', s.id);
        }
      });
    }
    
    // Également diffuser via l'ancien système tokenQR
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s !== socket) {
          s.emit('teacher-broadcast-offer', { offer, tokenQR });
        }
      });
    }
    
    // Diffuser à la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('teacher-broadcast-offer', { offer, tokenQR });
      console.log('[SERVER] Offre broadcast envoyée à TV:', tvSocket.id);
    }
  });

  // Réponse étudiant au broadcast enseignant
  socket.on('student-broadcast-answer', data => {
    const { sessionId, tokenQR, answer, studentId } = data;
    console.log('[SERVER] Réponse étudiant au broadcast:', studentId);
    
    // Envoyer à l'enseignant via sessionId
    if (sessionId && sessionRooms.has(sessionId)) {
      sessionRooms.get(sessionId).forEach(s => {
        if (s !== socket && s.role === 'teacher') {
          s.emit('student-broadcast-answer', { answer, studentId, sessionId });
          console.log('[SERVER] Réponse broadcast envoyée à enseignant:', s.id);
        }
      });
    }
    
    // Également via l'ancien système
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.userData?.role === 'enseignant') {
          s.emit('student-broadcast-answer', { answer, studentId, sessionId });
        }
      });
    }
  });

  // Réponse TV au broadcast enseignant
  socket.on('tv_broadcast_answer', data => {
    const { tokenQR, answer } = data;
    console.log('[SERVER] Réponse TV au broadcast:', tokenQR);
    
    // Envoyer à l'enseignant
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.userData?.role === 'enseignant') {
          s.emit('tv_broadcast_answer', { answer, tokenQR });
          console.log('[SERVER] Réponse broadcast TV envoyée à enseignant:', s.id);
        }
      });
    }
  });

  // --- 2. PRISE DE PAROLE ÉTUDIANT → ENSEIGNANT ---

  // Étudiant demande la parole (stream vers enseignant)
  socket.on('student-stream-offer', data => {
    const { sessionId, tokenQR, offer, studentId } = data;
    console.log('[SERVER] Étudiant demande parole:', studentId);
    
    // Envoyer à l'enseignant
    if (sessionId && sessionRooms.has(sessionId)) {
      sessionRooms.get(sessionId).forEach(s => {
        if (s !== socket && s.role === 'teacher') {
          s.emit('student-stream-offer', { offer, studentId, sessionId });
          console.log('[SERVER] Offre stream étudiant envoyée à enseignant:', s.id);
        }
      });
    }
    
    // Envoyer à la TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('student-stream-offer', { offer, studentId, tokenQR });
      console.log('[SERVER] Offre stream étudiant envoyée à TV:', tvSocket.id);
    }
    
    // Ancien système
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.userData?.role === 'enseignant') {
          s.emit('student-stream-offer', { offer, studentId, sessionId });
        }
      });
    }
  });

  // Réponse enseignant au stream étudiant
  socket.on('teacher-stream-answer', data => {
    const { sessionId, tokenQR, answer, studentId } = data;
    console.log('[SERVER] Enseignant répond au stream étudiant:', studentId);
    
    // Envoyer à l'étudiant spécifique
    if (sessionId && sessionRooms.has(sessionId)) {
      sessionRooms.get(sessionId).forEach(s => {
        if (s.userId === parseInt(studentId)) {
          s.emit('teacher-stream-answer', { answer, tokenQR });
          console.log('[SERVER] Réponse stream envoyée à étudiant:', s.id);
        }
      });
    }
    
    // Ancien système
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      const studentSocket = [...clients].find(s => s.userId === parseInt(studentId));
      if (studentSocket) {
        studentSocket.emit('teacher-stream-answer', { answer, tokenQR });
      }
    }
  });

  // Réponse TV au stream étudiant
  socket.on('tv_student_stream_answer', data => {
    const { tokenQR, answer, studentId } = data;
    console.log('[SERVER] Réponse TV au stream étudiant:', studentId);
    
    // Envoyer à l'étudiant spécifique
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      const studentSocket = [...clients].find(s => s.userId === parseInt(studentId));
      if (studentSocket) {
        studentSocket.emit('tv_stream_answer', { answer, tokenQR });
        console.log('[SERVER] Réponse stream TV envoyée à étudiant:', studentSocket.id);
      }
    }
  });

  // --- 3. CANDIDATS ICE UNIFIÉS ---

  // Candidats ICE de l'enseignant
  socket.on('teacher-ice-candidate', data => {
    const { sessionId, tokenQR, candidate, type, target, studentId } = data;
    console.log('[SERVER] ICE Candidat enseignant:', type, target || 'all');
    
    if (type === 'broadcast') {
      // Diffusion vers tous les étudiants
      if (sessionId && sessionRooms.has(sessionId)) {
        sessionRooms.get(sessionId).forEach(s => {
          if (s !== socket && s.role === 'student') {
            s.emit('teacher-ice-candidate', { candidate, tokenQR, type: 'broadcast' });
          }
        });
      }
      
      // Ancien système
      const clients = sessionClients.get(tokenQR);
      if (clients) {
        clients.forEach(s => {
          if (s !== socket) {
            s.emit('teacher-ice-candidate', { candidate, tokenQR, type: 'broadcast' });
          }
        });
      }
      
      // Envoyer à la TV
      const tvSocket = tvSockets.get(tokenQR);
      if (tvSocket) {
        tvSocket.emit('teacher-ice-candidate', { candidate, tokenQR, type: 'broadcast' });
      }
    } else if (type === 'stream' && (target || studentId)) {
      // Stream vers étudiant spécifique
      const targetStudentId = target || studentId;
      
      if (sessionId && sessionRooms.has(sessionId)) {
        sessionRooms.get(sessionId).forEach(s => {
          if (s.userId === parseInt(targetStudentId)) {
            s.emit('teacher-ice-candidate', { candidate, tokenQR, type: 'stream' });
          }
        });
      }
      
      // Ancien système
      const clients = sessionClients.get(tokenQR);
      if (clients) {
        const studentSocket = [...clients].find(s => s.userId === parseInt(targetStudentId));
        if (studentSocket) {
          studentSocket.emit('teacher-ice-candidate', { candidate, tokenQR, type: 'stream' });
        }
      }
    }
  });

  // Candidats ICE des étudiants
  socket.on('student-ice-candidate', data => {
    const { sessionId, tokenQR, candidate, studentId, type } = data;
    console.log('[SERVER] ICE Candidat étudiant:', studentId, type);
    
    if (type === 'broadcast') {
      // Réponse broadcast vers enseignant
      if (sessionId && sessionRooms.has(sessionId)) {
        sessionRooms.get(sessionId).forEach(s => {
          if (s !== socket && s.role === 'teacher') {
            s.emit('student-ice-candidate', { 
              candidate, 
              tokenQR, 
              sessionId,
              studentId, 
              type: 'broadcast'
            });
          }
        });
      }
      
      // Ancien système
      const clients = sessionClients.get(tokenQR);
      if (clients) {
        clients.forEach(s => {
          if (s.userData?.role === 'enseignant') {
            s.emit('student-ice-candidate', { 
              candidate, 
              tokenQR, 
              sessionId,
              studentId, 
              type: 'broadcast'
            });
          }
        });
      }
    } else if (type === 'stream') {
      // Stream vers enseignant
      if (sessionId && sessionRooms.has(sessionId)) {
        sessionRooms.get(sessionId).forEach(s => {
          if (s !== socket && s.role === 'teacher') {
            s.emit('student-ice-candidate', { 
              candidate, 
              tokenQR, 
              sessionId,
              studentId, 
              type: 'stream' 
            });
          }
        });
      }
      
      // Stream vers TV dashboard
      const tvSocket = tvSockets.get(tokenQR);
      if (tvSocket) {
        tvSocket.emit('student-ice-candidate', { candidate, studentId, type: 'stream' });
      }
      
      // Ancien système
      const clients = sessionClients.get(tokenQR);
      if (clients) {
        clients.forEach(s => {
          if (s.userData?.role === 'enseignant') {
            s.emit('student-ice-candidate', { 
              candidate, 
              tokenQR, 
              sessionId,
              studentId, 
              type: 'stream' 
            });
          }
        });
      }
    }
  });

  // Candidats ICE de la TV
  socket.on('tv_ice_candidate', data => {
    const { tokenQR, candidate, studentId } = data;
    console.log('[SERVER] ICE Candidat TV:', tokenQR);
    
    // Envoyer à l'enseignant ou à l'étudiant spécifique
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      if (studentId) {
        // Vers étudiant spécifique
        const studentSocket = [...clients].find(s => s.userId === parseInt(studentId));
        if (studentSocket) {
          studentSocket.emit('tv_ice_candidate', { candidate, tokenQR });
        }
      } else {
        // Vers enseignant
        clients.forEach(s => {
          if (s.userData?.role === 'enseignant') {
            s.emit('tv_ice_candidate', { candidate, tokenQR });
          }
        });
      }
    }
  });

  // Enseignant stoppe sa diffusion
  socket.on('teacher-stop-broadcast', data => {
    const { sessionId, tokenQR } = data;
    console.log('[SERVER] Enseignant stoppe diffusion:', sessionId);
    
    if (sessionId && sessionRooms.has(sessionId)) {
      sessionRooms.get(sessionId).forEach(s => {
        if (s !== socket) {
          s.emit('teacher-stop-broadcast', { tokenQR });
        }
      });
    }
    
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s !== socket) {
          s.emit('teacher-stop-broadcast', { tokenQR });
        }
      });
    }
    
    // Informer la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('teacher-stop-broadcast', { tokenQR });
    }
  });

  // ==========================================
  // ÉVÉNEMENTS CHAT ET INTERACTIONS CORRIGÉS
  // ==========================================

  // CORRECTION: Gestion chat message optimisée
  socket.on('chat_message', data => {
    console.log('[SERVER] Message chat reçu:', data);
    
    if (!data || !data.tokenQR || !data.message) {
      console.log('[SERVER] Données chat invalides');
      return;
    }
    
    const clients = sessionClients.get(data.tokenQR);
    if (clients) {
      const messageToSend = {
        user: data.user,
        message: data.message,
        timestamp: data.timestamp || new Date().toISOString(),
        isTeacher: data.isTeacher || false
      };
      
      // Diffuser à tous les clients SAUF l'expéditeur
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('chat_message', messageToSend);
        }
      });
      
      // Envoyer à la TV
      const tvSocket = tvSockets.get(data.tokenQR);
      if (tvSocket && tvSocket.id !== socket.id) {
        tvSocket.emit('chat_message', messageToSend);
      }
      
      console.log(`[SERVER] Message chat diffusé à ${clients.size} clients`);
    }
  });

  // Gestion mains levées : ajout (rétro-compatibilité)
  socket.on('student_raise_hand', data => {
    try {
      if (!data || !data.tokenQR || !data.user || !data.user.id) return;
      const tokenQR = data.tokenQR;
      if (!raisedHandsMap.has(tokenQR)) raisedHandsMap.set(tokenQR, new Map());
      const sessionRaisedHands = raisedHandsMap.get(tokenQR);
      const uid = String(data.user.id);
      if (!sessionRaisedHands.has(uid)) {
        sessionRaisedHands.set(uid, data.user);
        const clients = sessionClients.get(tokenQR);
        if (clients) {
          const uniqueClients = new Set(clients);
          uniqueClients.forEach(s => {
            s.emit('student_raise_hand', { user: data.user });
            s.emit('hand_raised', data); // Nouveau format
          });
        }
        
        // Envoyer au TV dashboard
        const tvSocket = tvSockets.get(tokenQR);
        if (tvSocket) {
          tvSocket.emit('hand_raised', { user: data.user });
        }
      }
    } catch (err) {
      console.error('[SERVER] Erreur student_raise_hand', err, data);
    }
  });

  // Gestion des mains levées (nouveau format)
  socket.on('hand_raised', data => {
    console.log('[SERVER] Main levée reçue:', data);
    
    if (!data || !data.tokenQR || !data.user) {
      console.log('[SERVER] Données main levée invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // Stocker la main levée
    if (!raisedHandsMap.has(tokenQR)) {
      raisedHandsMap.set(tokenQR, new Map());
    }
    
    raisedHandsMap.get(tokenQR).set(data.user.id, data.user);
    
    // Diffuser à tous les clients
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('hand_raised', data);
          s.emit('student_raise_hand', data); // Rétro-compatibilité
        }
      });
    }
    
    // Envoyer à la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('hand_raised', data);
    }
  });

  // Gestion mains levées : suppression (rétro-compatibilité)
  socket.on('student_lower_hand', data => {
    try {
      if (!data || !data.tokenQR || !data.user || !data.user.id) return;
      const tokenQR = data.tokenQR;
      if (!raisedHandsMap.has(tokenQR)) return;
      const sessionRaisedHands = raisedHandsMap.get(tokenQR);
      const uid = String(data.user.id);
      if (sessionRaisedHands.has(uid)) {
        sessionRaisedHands.delete(uid);
        const clients = sessionClients.get(tokenQR);
        if (clients) {
          clients.forEach(s => {
            s.emit('student_lower_hand', { user: data.user });
            s.emit('hand_lowered', data); // Nouveau format
          });
        }
        
        // Envoyer au TV dashboard
        const tvSocket = tvSockets.get(tokenQR);
        if (tvSocket) {
          tvSocket.emit('hand_lowered', { user: data.user });
        }
      }
    } catch (err) {
      console.error('[SERVER] Erreur student_lower_hand', err, data);
    }
  });

  // Gestion des mains baissées (nouveau format)
  socket.on('hand_lowered', data => {
    console.log('[SERVER] Main baissée reçue:', data);
    
    if (!data || !data.tokenQR || !data.user) {
      console.log('[SERVER] Données main baissée invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // Supprimer la main levée
    if (raisedHandsMap.has(tokenQR)) {
      raisedHandsMap.get(tokenQR).delete(data.user.id);
    }
    
    // Diffuser à tous les clients
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('hand_lowered', data);
          s.emit('student_lower_hand', data); // Rétro-compatibilité
        }
      });
    }
    
    // Envoyer à la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('hand_lowered', data);
    }
  });

  // Questions sourdines stock + relai (rétro-compatibilité)
  socket.on('student_question', data => {
    try {
      if (!data || !data.tokenQR || !data.user) return;
      if (!questionsBySession.has(data.tokenQR)) questionsBySession.set(data.tokenQR, []);
      const questions = questionsBySession.get(data.tokenQR);
      const questionId = Date.now().toString();
      const questionData = { 
        id: questionId,
        user: data.user, 
        message: data.message, 
        timestamp: new Date() 
      };
      questions.push(questionData);
      if (questions.length > 100) questions.splice(0, questions.length - 100);
      const clients = sessionClients.get(data.tokenQR);
      if (clients) {
        clients.forEach(s => {
          s.emit('student_question', { user: data.user, message: data.message });
          s.emit('new_question', questionData); // Nouveau format
        });
      }
      
      // Envoyer au TV dashboard
      const tvSocket = tvSockets.get(data.tokenQR);
      if (tvSocket) {
        tvSocket.emit('questions_updated', { questions });
        tvSocket.emit('new_question', questionData);
      }
    } catch (err) {
      console.error('[SERVER] Erreur student_question', err, data);
    }
  });

  // Gestion des questions (nouveau format)
  socket.on('new_question', data => {
    console.log('[SERVER] Nouvelle question reçue:', data);
    
    if (!data || !data.tokenQR || !data.message) {
      console.log('[SERVER] Données question invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // Stocker la question
    if (!questionsBySession.has(tokenQR)) {
      questionsBySession.set(tokenQR, []);
    }
    
    const questionId = Date.now().toString();
    const question = {
      id: questionId,
      user: data.user,
      message: data.message,
      timestamp: data.timestamp || new Date().toISOString()
    };
    
    questionsBySession.get(tokenQR).push(question);
    
    // Diffuser à tous les clients
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('new_question', question);
          s.emit('student_question', { user: data.user, message: data.message }); // Rétro-compatibilité
        }
      });
    }
    
    // Envoyer à la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('new_question', question);
    }
  });

  // NOUVEAU: Gestion questions sourdines depuis enseignant
  socket.on('questions_sourdines_update', data => {
    const { tokenQR, questions } = data;
    if (!tokenQR) return;
    
    // Mettre à jour le cache
    questionsBySession.set(tokenQR, questions || []);
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('questions_sourdines_update', { questions });
    }
    
    console.log(`[SERVER] Questions sourdines mises à jour: ${questions?.length || 0} questions`);
  });

  // Effacer une question
  socket.on('clear_question', data => {
    console.log('[SERVER] Effacement question reçu:', data);
    
    if (!data || !data.tokenQR || !data.questionId) {
      console.log('[SERVER] Données effacement question invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // Supprimer la question
    if (questionsBySession.has(tokenQR)) {
      const questions = questionsBySession.get(tokenQR);
      const index = questions.findIndex(q => q.id === data.questionId);
      
      if (index !== -1) {
        questions.splice(index, 1);
      }
    }
    
    // Diffuser à tous les clients
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('question_cleared', { questionId: data.questionId });
      });
    }
    
    // Envoyer à la TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('question_cleared', { questionId: data.questionId });
    }
  });

  // Nettoyage questions sourdines (rétro-compatibilité)
  socket.on('clear_questions', data => {
    const tokenQR = data?.tokenQR || data;
    if (questionsBySession.has(tokenQR)) {
      questionsBySession.delete(tokenQR);
      const clients = sessionClients.get(tokenQR);
      if (clients) clients.forEach(s => {
        s.emit('marquee_questions', []);
        s.emit('clear_questions'); // Nouveau format
      });
      
      // Envoyer au TV dashboard
      const tvSocket = tvSockets.get(tokenQR);
      if (tvSocket) {
        tvSocket.emit('questions_updated', { questions: [] });
        tvSocket.emit('clear_questions');
      }
    }
  });

  // Gestion prise de parole WebRTC
  socket.on('give_hand_to_student', async data => {
    const { tokenQR, studentId, sessionId } = data;
    if (!tokenQR || !studentId) return;

    currentSpeaker.set(tokenQR, { type: 'student', studentId, socketId: socket.id });

    // Vérifie ou crée la map interne pour ce tokenQR
    if (!studentInfoCache.has(tokenQR)) {
      studentInfoCache.set(tokenQR, new Map());
    }
    const cacheForSession = studentInfoCache.get(tokenQR);

    let prenom = '';
    let nom = '';

    if (cacheForSession.has(studentId)) {
      const userInfo = cacheForSession.get(studentId);
      prenom = userInfo.prenom;
      nom = userInfo.nom;
    } else {
      try {
        const result = await pool.query('SELECT prenom, nom FROM users WHERE id=$1', [studentId]);
        if (result.rowCount > 0) {
          prenom = result.rows[0].prenom || '';
          nom = result.rows[0].nom || '';
        } else {
          prenom = 'Étudiant';
          nom = '';
        }
      } catch (e) {
        console.error('[SERVER] Erreur récupération étudiant pour give_hand_to_student', e);
        prenom = 'Étudiant';
        nom = '';
      }
      cacheForSession.set(studentId, { prenom, nom });
    }

    const clients = sessionClients.get(tokenQR);
    if (clients) {
      const uniqueClients = new Set(clients);
      uniqueClients.forEach(s => {
        s.emit('student_speech_started', { studentId });
      });
    }
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('student_interface_update', {
        studentId: studentId,
        studentName: `${prenom} ${nom}`.trim(),
        hasPermission: true,
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`[SERVER] Parole donnée à l'étudiant ${studentId}`);
  });

  // Retirer la parole
  socket.on('remove_hand_to_student', data => {
    const { tokenQR, studentId } = data;
    if (!tokenQR || !studentId) return;

    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('remove_hand_to_student', { studentId });
      });
    }
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('student_interface_update', {
        studentId: studentId,
        hasPermission: false,
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`[SERVER] Parole retirée à l'étudiant ${studentId}`);
  });

  // ==========================================
  // ÉVÉNEMENTS NOTES PARTAGÉES
  // ==========================================

  // Mise à jour des notes partagées en temps réel (rétro-compatibilité)
  socket.on('shared_notes_update', data => {
    const { tokenQR, content, author, timestamp } = data;
    if (!tokenQR || typeof content !== 'string') return;
    
    // Mettre à jour le contenu
    sharedNotesContent.set(tokenQR, content);
    
    // Diffuser à tous les clients sauf l'auteur
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('shared_notes_update', { content, author, timestamp });
          s.emit('shared_notes_content', { content }); // Nouveau format
        }
      });
    }
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket && tvSocket.id !== socket.id) {
      tvSocket.emit('shared_notes_update', { content, author, timestamp });
      tvSocket.emit('shared_notes_content', { content });
    }
    
    console.log(`[SERVER] Notes partagées mises à jour par ${author?.prenom || 'Utilisateur'}`);
  });

  // NOUVEAU: rejoindre l'espace de notes, recevoir le contenu existant et annoncer la présence
  socket.on('notes_join', data => {
    const { tokenQR, user } = data || {};
    if (!tokenQR) return;

    ensureSessionDirectory(tokenQR);

    if (!notesActiveEditors.has(tokenQR)) {
      notesActiveEditors.set(tokenQR, new Map());
    }
    notesActiveEditors.get(tokenQR).set(socket.id, user || { id: socket.id });

    // Donner l'autorisation d'écriture à tous par défaut côté client
    socket.emit('shared_notes_permission_changed', { allowed: true });

    // Envoyer le contenu courant
    const existing = sharedNotesContent.get(tokenQR) || '';
    socket.emit('shared_notes_content', { content: existing });

    // Diffuser la liste mise à jour des éditeurs actifs
    const editors = Array.from(notesActiveEditors.get(tokenQR).values());
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('notes_user_joined', { user });
          s.emit('notes_editors', { editors });
        }
      });
    }
  });

  // NOUVEAU: quitter l'espace de notes
  socket.on('notes_leave', data => {
    const { tokenQR, user } = data || {};
    if (!tokenQR) return;

    if (notesActiveEditors.has(tokenQR)) {
      notesActiveEditors.get(tokenQR).delete(socket.id);
      if (notesActiveEditors.get(tokenQR).size === 0) {
        notesActiveEditors.delete(tokenQR);
      }
    }

    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('notes_user_left', { user });
        }
      });
    }
  });

  // NOUVEAU: indicateurs de frappe (typing)
  socket.on('notes_typing_start', data => {
    const { tokenQR, user } = data || {};
    if (!tokenQR) return;
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('notes_typing', { user, typing: true });
        }
      });
    }
  });

  socket.on('notes_typing_stop', data => {
    const { tokenQR, user } = data || {};
    if (!tokenQR) return;
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('notes_typing', { user, typing: false });
        }
      });
    }
  });

  // NOUVEAU: renvoyer le contenu à la demande
  socket.on('notes_request_content', data => {
    const { tokenQR } = data || {};
    if (!tokenQR) return;
    const existing = sharedNotesContent.get(tokenQR) || '';
    socket.emit('shared_notes_content', { content: existing });
  });

  // Publication des notes partagées
  socket.on('shared_notes_published', data => {
    const { tokenQR, notes, author, fileName } = data;
    if (!tokenQR || !notes) return;
    
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('shared_notes_published', { notes, author, fileName });
      });
    }
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('shared_notes_published', { notes, author, fileName });
    }
    
    console.log(`[SERVER] Notes partagées publiées par ${author?.prenom || 'Utilisateur'}`);
  });

  // Gestion des permissions d'écriture pour les notes
  socket.on('shared_notes_permission', data => {
    const { tokenQR, studentId, allowed } = data;
    if (!tokenQR || !studentId) return;
    
    if (!notesCollaborators.has(tokenQR)) {
      notesCollaborators.set(tokenQR, new Set());
    }
    
    const collaborators = notesCollaborators.get(tokenQR);
    if (allowed) {
      collaborators.add(studentId);
    } else {
      collaborators.delete(studentId);
    }
    
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      const studentSocket = [...clients].find(s => s.userId === parseInt(studentId));
      if (studentSocket) {
        studentSocket.emit('shared_notes_permission_changed', { allowed });
      }
    }
    
    console.log(`[SERVER] Permission notes ${allowed ? 'accordée' : 'retirée'} pour étudiant ${studentId}`);
  });

  // Permission pour tous
  socket.on('shared_notes_permission_all', data => {
    const { tokenQR, allowed } = data;
    if (!tokenQR) return;
    
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('shared_notes_permission_changed', { allowed });
      });
    }
    
    console.log(`[SERVER] Permission notes ${allowed ? 'accordée' : 'retirée'} pour tous`);
  });

  // Partager les notes (générer PDF)
  socket.on('share_notes', async data => {
    console.log('[SERVER] Partage notes reçu');
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données partage notes invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    const content = sharedNotesContent.get(tokenQR) || '';
    
    try {
      // Générer le PDF
      const pdfPath = await generateNotesPDF(tokenQR, content);
      
      if (pdfPath) {
        // Informer l'émetteur
        socket.emit('notes_shared', { 
          success: true, 
          message: 'Notes partagées enregistrées en PDF',
          pdfPath: pdfPath
        });
        
        // Informer les autres clients
        const clients = sessionClients.get(tokenQR);
        if (clients) {
          clients.forEach(s => {
            if (s.id !== socket.id) {
              s.emit('notes_shared', { 
                success: true, 
                message: 'Nouvelles notes partagées disponibles'
              });
            }
          });
        }
      } else {
        socket.emit('notes_shared', { 
          success: false, 
          message: 'Erreur lors de la génération du PDF'
        });
      }
    } catch (error) {
      console.error('Erreur partage notes:', error);
      socket.emit('notes_shared', { 
        success: false, 
        message: 'Erreur lors du partage des notes'
      });
    }
  });

  // Générer un résumé des notes
  socket.on('summarize_notes', async data => {
    console.log('[SERVER] Résumé notes demandé');
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données résumé notes invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    const content = sharedNotesContent.get(tokenQR) || '';
    
    try {
      // Générer le résumé
      const result = await generateNotesSummary(tokenQR, content);
      
      if (result) {
        // Informer l'émetteur
        socket.emit('notes_summary', { 
          success: true, 
          message: 'Résumé des notes généré',
          summary: result.summary,
          pdfPath: result.filePath
        });
        
        // Informer les autres clients
        const clients = sessionClients.get(tokenQR);
        if (clients) {
          clients.forEach(s => {
            if (s.id !== socket.id) {
              s.emit('notes_summary', { 
                success: true, 
                message: 'Nouveau résumé des notes disponible'
              });
            }
          });
        }
      } else {
        socket.emit('notes_summary', { 
          success: false, 
          message: 'Erreur lors de la génération du résumé'
        });
      }
    } catch (error) {
      console.error('Erreur résumé notes:', error);
      socket.emit('notes_summary', { 
        success: false, 
        message: 'Erreur lors de la génération du résumé'
      });
    }
  });

  // ==========================================
  // ÉVÉNEMENTS QUIZ
  // ==========================================

  socket.on('quiz_activated', data => {
    const { tokenQR, quiz } = data;
    if (!tokenQR || !quiz) return;
    
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('quiz_started', { quiz });
      });
    }
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('quiz_started', { quiz });
    }
    
    console.log('[SERVER] Quiz activé:', quiz.question);
  });

  socket.on('quiz_deactivated', data => {
    const { tokenQR } = data;
    if (!tokenQR) return;
    
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('quiz_stopped');
      });
    }
    
    // Envoyer au TV dashboard
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('quiz_stopped');
    }
    
    console.log('[SERVER] Quiz désactivé');
  });

  // ==========================================
  // GESTION DES DOCUMENTS DE COURS
  // ==========================================

  // Ajouter un document à la session
  socket.on('add_session_document', data => {
    console.log('[SERVER] Ajout document session reçu');
    
    if (!data || !data.tokenQR || !data.document) {
      console.log('[SERVER] Données document session invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    // Stocker le document
    if (!sessionDocuments.has(tokenQR)) {
      sessionDocuments.set(tokenQR, []);
    }
    
    sessionDocuments.get(tokenQR).push(data.document);
    
    // Diffuser à tous les clients
    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        if (s.id !== socket.id) {
          s.emit('session_document_added', { document: data.document });
        }
      });
    }
  });

  // Récupérer les documents de la session
  socket.on('get_session_documents', data => {
    console.log('[SERVER] Récupération documents session reçue');
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données récupération documents invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    const documents = sessionDocuments.get(tokenQR) || [];
    
    socket.emit('session_documents', { documents });
  });

  // ==========================================
  // GESTION DE LA LISTE DE PRÉSENCE
  // ==========================================

  // Récupérer la liste de présence
  socket.on('get_attendance_list', data => {
    console.log('[SERVER] Récupération liste présence reçue');
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données récupération présence invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    const attendanceMap = sessionAttendance.get(tokenQR) || new Map();
    const attendanceList = Array.from(attendanceMap.values());
    
    socket.emit('attendance_list', { attendanceList });
  });

  // Générer le PDF de présence
  socket.on('generate_attendance_pdf', async data => {
    console.log('[SERVER] Génération PDF présence demandée');
    
    if (!data || !data.tokenQR) {
      console.log('[SERVER] Données génération PDF présence invalides');
      return;
    }
    
    const tokenQR = data.tokenQR;
    
    try {
      // Générer le PDF
      const pdfPath = await generateAttendancePDF(tokenQR);
      
      if (pdfPath) {
        socket.emit('attendance_pdf_generated', { 
          success: true, 
          message: 'Liste de présence enregistrée en PDF',
          pdfPath: pdfPath
        });
      } else {
        socket.emit('attendance_pdf_generated', { 
          success: false, 
          message: 'Erreur lors de la génération du PDF'
        });
      }
    } catch (error) {
      console.error('Erreur génération PDF présence:', error);
      socket.emit('attendance_pdf_generated', { 
        success: false, 
        message: 'Erreur lors de la génération du PDF'
      });
    }
  });

  // ==========================================
  // ÉVÉNEMENTS DIVERS
  // ==========================================

  // Mise à jour interface étudiant
  socket.on('student_interface_update', data => {
    const { tokenQR } = data;
    if (!tokenQR) return;
    
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('student_interface_update', data);
    }
    
    console.log('[SERVER] Interface étudiant mise à jour:', data);
  });

  // Étudiant stoppe diffusion webcam, parole revient au prof
  socket.on('student_stop_speech', data => {
    const { tokenQR, studentId } = data;
    currentSpeaker.set(tokenQR, { type: 'teacher' });

    const clients = sessionClients.get(tokenQR);
    if (clients) {
      clients.forEach(s => {
        s.emit('teacher_speech_resumed');
        s.emit('student-stop-stream', { studentId, tokenQR });
      });
    }
    
    // Nettoyer TV
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('student-stop-stream', { studentId });
    }
  });

  // CORRECTION : Nettoyage amélioré à la déconnexion
  socket.on('disconnect', (reason) => {
    console.log('[SERVER] Socket déconnecté:', socket.id, 'Raison:', reason);
    
    // Si c'est une déconnexion utilisateur, notifier les TV
    if (socket.userData) {
      io.emit('user_connection_lost', {
        userId: socket.userData.id,
        reason: reason,
        timestamp: new Date().toISOString()
      });
    }

    // Retirer des éditeurs actifs de notes le cas échéant
    if (socket.sessionToken && notesActiveEditors.has(socket.sessionToken)) {
      const user = notesActiveEditors.get(socket.sessionToken).get(socket.id);
      notesActiveEditors.get(socket.sessionToken).delete(socket.id);
      const clients = sessionClients.get(socket.sessionToken);
      if (clients && user) {
        clients.forEach(s => {
          if (s.id !== socket.id) {
            s.emit('notes_user_left', { user });
          }
        });
      }
      if (notesActiveEditors.get(socket.sessionToken).size === 0) {
        notesActiveEditors.delete(socket.sessionToken);
      }
    }

    // Mettre à jour l'heure de départ dans la liste de présence
    if (socket.sessionToken && socket.userId && sessionAttendance.has(socket.sessionToken)) {
      const attendanceMap = sessionAttendance.get(socket.sessionToken);
      if (attendanceMap.has(socket.userId)) {
        const record = attendanceMap.get(socket.userId);
        record.leaveTime = new Date();
        attendanceMap.set(socket.userId, record);
      }
    }
    
    // Supprimer le socket des clients de session
    if (socket.sessionToken && sessionClients.has(socket.sessionToken)) {
      const clients = sessionClients.get(socket.sessionToken);
      clients.delete(socket);
      
      // Mettre à jour le compteur d'étudiants
      const studentCount = [...clients].filter(s => s.userData?.role === 'etudiant').length;
      
      clients.forEach(s => {
        s.emit('students_count_update', { count: studentCount });
      });
      
      // Informer la TV
      const tvSocket = tvSockets.get(socket.sessionToken);
      if (tvSocket) {
        tvSocket.emit('students_count_update', { count: studentCount });
      }
      
      // Informer de la déconnexion utilisateur
      if (socket.userId && socket.userData) {
        const disconnectData = {
          userId: socket.userId,
          user: socket.userData,
          tokenQR: socket.sessionToken,
          timestamp: new Date().toISOString()
        };
        
        clients.forEach(s => {
          s.emit('user_logged_out', disconnectData);
        });
        
        if (tvSocket) {
          tvSocket.emit('user_logged_out', disconnectData);
        }
      }

      if (clients.size === 0) {
        sessionClients.delete(socket.sessionToken);
      }
    }
    
    // Nettoyer sessionRooms
    if (socket.sessionId && sessionRooms.has(socket.sessionId)) {
      sessionRooms.get(socket.sessionId).delete(socket);
      if (sessionRooms.get(socket.sessionId).size === 0) {
        sessionRooms.delete(socket.sessionId);
      }
    }
    
    // Nettoyer tvSockets avec vérification
    if (socket.tokenQR && tvSockets.has(socket.tokenQR)) {
      if (tvSockets.get(socket.tokenQR) === socket) {
        tvSockets.delete(socket.tokenQR);
        console.log(`[SERVER] 🗑️ TV supprimée pour token: ${socket.tokenQR}`);
      }
    }
    
    // Alternative : nettoyer par comparaison de socket
    tvSockets.forEach((sock, token) => {
      if (sock === socket) {
        tvSockets.delete(token);
        console.log(`[SERVER] 🗑️ TV supprimée pour token: ${token}`);
      }
    });
  });
});

// ==========================================
// ROUTES EXPRESS
// ==========================================

// Création utilisateur (admin uniquement)
app.post('/admin/register', authMiddleware, async (req, res) => {
  if(req.user.role !== 'admin') return res.status(403).json({ error: 'Accès réservé à l\'admin' });
  const { nom, prenom, email, motDePasse, role } = req.body;
  if(!nom || !prenom || !email || !motDePasse || !role) return res.status(400).json({ error: 'Tous les champs sont requis' });
  if(!['admin','enseignant','etudiant'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
  try {
    const hash = await bcrypt.hash(motDePasse, 10);
    const result = await pool.query(
      'INSERT INTO users (nom, prenom, email, mot_de_passe_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, nom, prenom, email, role',
      [nom, prenom, email, hash, role]
    );
    res.json({ message: 'Utilisateur créé', user: result.rows[0] });
  } catch(e) {
    if(e.code === '23505') res.status(409).json({ error: 'Email déjà utilisé' });
    else {
      console.error(e);
      res.status(500).json({ error: 'Erreur serveur création utilisateur' });
    }
  }
});

//Creation cours
app.post('/courses', authMiddleware, async (req, res) => {
  if (!['enseignant','admin'].includes(req.user.role)) return res.status(403).json({ error: 'Accès interdit' });
  const { titre, date_debut, date_fin, enseignantId } = req.body;
  let enseignant = req.user.id;
  if(req.user.role === 'admin' && enseignantId) enseignant = enseignantId;
  try {
    const courseRes = await pool.query(
      'INSERT INTO courses (titre, enseignant_id, date_debut, date_fin) VALUES ($1, $2, $3, $4) RETURNING *',
      [titre, enseignant, date_debut || null, date_fin || null]
    );
    res.json({ message: 'Cours créé', course: courseRes.rows[0] });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur création cours' });
  }
});

// Liste des cours (enseignant / admin)
app.get('/courses', authMiddleware, async (req, res) => {
  try {
    if(req.user.role === 'enseignant') {
      const courses = await pool.query('SELECT * FROM courses WHERE enseignant_id = $1', [req.user.id]);
      return res.json({ courses: courses.rows });
    }
    if(req.user.role === 'admin') {
      const courses = await pool.query('SELECT c.*, u.nom AS nom_enseignant, u.prenom AS prenom_enseignant FROM courses c JOIN users u ON c.enseignant_id = u.id');
      return res.json({ courses: courses.rows });
    }
    res.status(403).json({ error: 'Accès interdit' });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur récupération cours' });
  }
});

// Authentification générale
app.post('/login', async (req, res) => {
  const { email, motDePasse } = req.body;
  if (!email || !motDePasse) return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rowCount === 0) return res.status(401).json({ error: 'Utilisateur non trouvé' });

    const user = userRes.rows[0];
    const valid = await bcrypt.compare(motDePasse, user.mot_de_passe_hash);
    if (!valid) return res.status(403).json({ error: 'Mot de passe incorrect' });

    const tokenPayload = { id: user.id, role: user.role, nom: user.nom, prenom: user.prenom };
    const token = jwt.sign(tokenPayload, SECRET_KEY, { expiresIn: '4h' });

    res.json({ 
      message: 'Connexion réussie', 
      token, 
      user: {
        id: user.id,
        prenom: user.prenom,
        nom: user.nom,
        email: user.email,
        role: user.role
      }
    });
  } catch(e) {
    console.error('Erreur serveur connexion:', e);
    res.status(500).json({ error: 'Erreur serveur connexion' });
  }
});

// CORRECTION : Démarrer une session avec durée étendue
app.post('/start-course', authMiddleware, async (req, res) => {
  if (req.user.role !== 'enseignant') {
    return res.status(403).json({ error: 'Accès réservé aux enseignants' });
  }
  
  const { courseId } = req.body;
  
  try {
    const coursRes = await pool.query(
      'SELECT * FROM courses WHERE id = $1 and enseignant_id = $2', 
      [courseId, req.user.id]
    );
    
    if (coursRes.rowCount === 0) {
      return res.status(404).json({ error: 'Cours non trouvé' });
    }

    // Fermer toutes les autres sessions
    await pool.query("UPDATE sessions SET statut='fermee' WHERE statut='ouverte'");

    // Créer un token avec durée étendue (4 heures au lieu de 2)
    const tokenQR = jwt.sign(
      { 
        courseId, 
        enseignantId: req.user.id, 
        iat: Math.floor(Date.now() / 1000) 
      },
      SECRET_KEY,
      { expiresIn: '4h' }
    );

    const sessionRes = await pool.query(
      'INSERT INTO sessions (course_id, token_qr, statut) VALUES ($1, $2, $3) RETURNING *',
      [courseId, tokenQR, 'ouverte']
    );

    console.log('[SERVER] ✅ Nouvelle session créée:', sessionRes.rows[0].id);

    res.json({ 
      message: 'Session démarrée', 
      session: sessionRes.rows[0], 
      tokenQR,
      validity: '4 heures'
    });
    
  } catch (e) {
    console.error('[SERVER] Erreur serveur démarrage session:', e);
    res.status(500).json({ error: 'Erreur serveur démarrage session' });
  }
});

// CORRECTION : Amélioration de la route /current-session
app.get('/current-session', async (req, res) => {
  try {
    const sessionRes = await pool.query(`
      SELECT s.*, c.titre as course_title 
      FROM sessions s 
      LEFT JOIN courses c ON s.course_id = c.id 
      WHERE s.statut='ouverte' 
      ORDER BY s.date_creation DESC 
      LIMIT 1
    `);
    
    if (sessionRes.rowCount === 0) {
      return res.json({ active: false, message: 'Pas de cours en ligne' });
    }
    
    const session = sessionRes.rows[0];
    res.json({ 
      active: true, 
      tokenQR: session.token_qr, 
      sessionId: session.id,
      course_title: session.course_title || 'Cours sans titre'
    });
  } catch (e) {
    console.error('Erreur récupération session:', e);
    res.status(500).json({ error: 'Erreur récupération session' });
  }
});

// CORRECTION : Route join-session modifiée pour accepter les reconnexions
app.post('/join-session', authMiddleware, async (req, res) => {
  const { tokenQR } = req.body;
  
  if (req.user.role !== 'etudiant') {
    return res.status(403).json({ error: 'Réservé aux étudiants' });
  }
  
  try {
    const sessionRes = await pool.query(
      "SELECT * FROM sessions WHERE token_qr=$1 AND statut='ouverte'", 
      [tokenQR]
    );
    
    if (sessionRes.rowCount === 0) {
      return res.status(404).json({ error: 'Session introuvable ou fermée' });
    }
    
    const session = sessionRes.rows[0];
    console.log('[SERVER] Étudiant rejoint session:', req.user.prenom, req.user.nom);

    const existingLogin = await pool.query(
      'SELECT * FROM logins WHERE session_id=$1 AND user_id=$2 AND date_logout IS NULL', 
      [session.id, req.user.id]
    );
    
    if (existingLogin.rowCount === 0) {
      await pool.query(
        'INSERT INTO logins (session_id, user_id) VALUES ($1, $2)', 
        [session.id, req.user.id]
      );
      console.log('[SERVER] ✅ Nouveau login créé pour étudiant');
    } else {
      console.log('[SERVER] ✅ Étudiant déjà connecté à cette session');
    }

    // Notifier la TV (si disponible)
    const tvSocket = tvSockets.get(tokenQR);
    if (tvSocket) {
      tvSocket.emit('user_logged_in', { 
        nom: req.user.nom, 
        prenom: req.user.prenom,
        id: req.user.id,
        role: req.user.role,
        email: req.user.email,
        tokenQR: tokenQR,
        reconnection: existingLogin.rowCount > 0
      });
      console.log('[SERVER] 📺 TV notifiée de la connexion étudiant');
    }

    res.json({ 
      message: `Bienvenue en classe ${req.user.prenom} ${req.user.nom}`,
      reconnection: existingLogin.rowCount > 0,
      sessionId: session.id,
      success: true,
      session: {
        id: session.id,
        title: session.course_title || 'Session en cours',
        tokenQR: session.token_qr
      }
    });
    
  } catch (e) {
    console.error('[SERVER] Erreur connexion session:', e);
    res.status(500).json({ error: 'Erreur serveur connexion session' });
  }
});

// NOUVEAU: Route pour les notes partagées
app.post('/session/:sessionId/shared-notes', authMiddleware, async (req, res) => {
  const { notes, author, timestamp } = req.body;
  const sessionId = parseInt(req.params.sessionId);
  
  try {
    // Sauvegarder en base de données (optionnel)
    const result = await pool.query(
      'INSERT INTO shared_notes (session_id, content, author_id, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [sessionId, notes, req.user.id, timestamp || new Date()]
    );
    
    res.json({ 
      message: 'Notes partagées sauvegardées',
      noteId: result.rows[0].id
    });
  } catch (e) {
    console.error('Erreur sauvegarde notes partagées:', e);
    res.status(500).json({ error: 'Erreur sauvegarde notes' });
  }
});

// NOUVEAU: récupérer le contenu courant des notes partagées (par token)
app.get('/session/:tokenQR/shared-notes', authMiddleware, async (req, res) => {
  const { tokenQR } = req.params;
  try {
    const content = sharedNotesContent.get(tokenQR) || '';
    res.json({ content });
  } catch (e) {
    console.error('Erreur récupération contenu notes:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// NOUVEAU: lister et télécharger les PDFs de notes générés
app.get('/session/:tokenQR/notes/pdfs', authMiddleware, (req, res) => {
  const { tokenQR } = req.params;
  try {
    const { notesDir } = ensureSessionDirectory(tokenQR);
    if (!fs.existsSync(notesDir)) return res.json([]);
    const files = fs.readdirSync(notesDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    res.json(files);
  } catch (e) {
    console.error('Erreur liste PDFs notes:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/session/:tokenQR/notes/pdfs/:fileName', authMiddleware, (req, res) => {
  const { tokenQR, fileName } = req.params;
  try {
    const { notesDir } = ensureSessionDirectory(tokenQR);
    const filePath = path.join(notesDir, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier non trouvé' });
    res.download(filePath, fileName);
  } catch (e) {
    console.error('Erreur téléchargement PDF notes:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// NOUVEAU: lister et télécharger les PDFs de présence générés
app.get('/session/:tokenQR/attendance/pdfs', authMiddleware, (req, res) => {
  const { tokenQR } = req.params;
  try {
    const { attendanceDir } = ensureSessionDirectory(tokenQR);
    if (!fs.existsSync(attendanceDir)) return res.json([]);
    const files = fs.readdirSync(attendanceDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    res.json(files);
  } catch (e) {
    console.error('Erreur liste PDFs présence:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/session/:tokenQR/attendance/pdfs/:fileName', authMiddleware, (req, res) => {
  const { tokenQR, fileName } = req.params;
  try {
    const { attendanceDir } = ensureSessionDirectory(tokenQR);
    const filePath = path.join(attendanceDir, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Fichier non trouvé' });
    res.download(filePath, fileName);
  } catch (e) {
    console.error('Erreur téléchargement PDF présence:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});




// Route pour vérifier si une session est active
app.get('/check-session-active/:tokenQR', async (req, res) => {
  const { tokenQR } = req.params;
  
  try {
    console.log('[SERVER] Vérification session active pour token:', tokenQR);
    
    const sessionRes = await pool.query(
      "SELECT * FROM sessions WHERE token_qr = $1 AND statut = 'ouverte'",
      [tokenQR]
    );
    
    if (sessionRes.rowCount === 0) {
      console.log('[SERVER] ❌ Session non trouvée ou fermée pour token:', tokenQR);
      return res.json({ 
        active: false, 
        message: 'Session non trouvée ou fermée' 
      });
    }
    
    const session = sessionRes.rows[0];
    console.log('[SERVER] ✅ Session trouvée, ID:', session.id);
    
    let tokenValid = false;
    let tokenMessage = '';
    
    try {
      const decoded = jwt.verify(tokenQR, SECRET_KEY);
      tokenValid = true;
      tokenMessage = 'Token valide';
      console.log('[SERVER] ✅ Token JWT valide');
    } catch (jwtError) {
      console.log('[SERVER] ⚠️ Token JWT expiré ou invalide:', jwtError.message);
      tokenValid = false;
      tokenMessage = 'Token expiré mais session active';
    }
    
    const sessionActive = session.statut === 'ouverte';
    
    if (sessionActive) {
      console.log('[SERVER] ✅ Session confirmée active');
      res.json({ 
        active: true, 
        sessionId: session.id,
        tokenValid: tokenValid,
        message: tokenMessage,
        sessionStatus: session.statut,
        allowAccess: true
      });
    } else {
      console.log('[SERVER] ❌ Session fermée');
      res.json({ 
        active: false, 
        message: 'Session fermée',
        sessionStatus: session.statut 
      });
    }
    
  } catch (e) {
    console.error('[SERVER] Erreur vérification session active:', e);
    res.status(500).json({ 
      active: false, 
      error: 'Erreur serveur',
      message: 'Impossible de vérifier le statut de la session'
    });
  }
});

// Terminer session (enseignant)
app.post('/session/:sessionId/end', authMiddleware, async (req, res) => {
  if(req.user.role !== 'enseignant') return res.status(403).json({ error: 'Interdit' });
  const sessionId = parseInt(req.params.sessionId);
  try {
    const sessRes = await pool.query(`
      SELECT s.*, c.enseignant_id FROM sessions s
      JOIN courses c ON s.course_id = c.id
      WHERE s.id = $1
    `, [sessionId]);

    if(sessRes.rowCount === 0 || sessRes.rows[0].enseignant_id !== req.user.id)
      return res.status(403).json({ error: 'Accès interdit' });

    await pool.query("UPDATE sessions SET statut='fermee' WHERE id = $1", [sessionId]);
    await pool.query("UPDATE logins SET date_logout = NOW() WHERE session_id = $1 AND date_logout IS NULL", [sessionId]);

    const tokenQR = sessRes.rows[0].token_qr;

    if(tvSockets.has(tokenQR)){
      const tvSocket = tvSockets.get(tokenQR);
      tvSocket.emit('session_ended');
      tvSockets.delete(tokenQR);
    }

    if(sessionClients.has(tokenQR)){
      sessionClients.get(tokenQR).forEach(s => s.emit('session_ended'));
      sessionClients.delete(tokenQR);
    }

    if (studentInfoCache.has(tokenQR)) {
      studentInfoCache.delete(tokenQR);
    }

    res.json({ message: 'Session terminée, présences sauvegardées.' });
  } catch(e) {
    console.error('Erreur clôture session:', e);
    res.status(500).json({ error: 'Erreur clôture session' });
  }
});

// Déconnexion étudiant
app.post('/logout', authMiddleware, async (req, res) => {
  const { tokenQR } = req.body;
  try {
    const sessionRes = await pool.query("SELECT * FROM sessions WHERE token_qr=$1 AND statut='ouverte'", [tokenQR]);
    if(sessionRes.rowCount === 0) return res.status(404).json({ error: 'Session non trouvée' });
    const session = sessionRes.rows[0];
    await pool.query("UPDATE logins SET date_logout=NOW() WHERE session_id=$1 AND user_id=$2 AND date_logout IS NULL", [session.id, req.user.id]);
    const tvSocket = tvSockets.get(tokenQR);
    if(tvSocket) tvSocket.emit('user_logged_out', { userId: req.user.id });
    res.json({ message: 'Déconnexion réussie' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur déconnexion' });
  }
});

// Quiz routes (activation + création)
app.post('/quiz/toggle', authMiddleware, async(req,res) => {
  if(req.user.role !== 'enseignant') return res.status(403).json({ error: 'Accès interdit' });
  const { sessionId, actif } = req.body;
  if(typeof actif !== "boolean" || !sessionId) return res.status(400).json({error:'Données invalides'});
  try {
    await pool.query('UPDATE quizzes SET active=$1 WHERE session_id=$2', [actif, sessionId]);
    const sessionRes = await pool.query('SELECT token_qr FROM sessions WHERE id=$1', [sessionId]);
    if(sessionRes.rowCount === 0) return res.status(404).json({error:'Session introuvable'});
    const tokenQR = sessionRes.rows[0].token_qr;
    const clients = sessionClients.get(tokenQR);
    if(clients){
      clients.forEach(s => s.emit('quiz_toggle', { actif }));
    }
    res.json({ message: `Quiz ${actif?'activé':'désactivé'}` });
  } catch(e){
    console.error(e);
    res.status(500).json({error:'Erreur activation quiz'});
  }
});

app.post('/quiz/create', authMiddleware, async(req,res) => {
  if(req.user.role !== 'enseignant') return res.status(403).json({ error:'Interdit' });
  const { sessionId, question, reponses, bonne_reponse_id } = req.body;
  if(!sessionId || !question || !reponses || !bonne_reponse_id) return res.status(400).json({ error:'Données manquantes' });
  try {
    const insertRes = await pool.query('INSERT INTO quizzes(session_id, question, reponses, bonne_reponse_id, active) VALUES($1,$2,$3,$4,FALSE) RETURNING *',
                                      [sessionId, question, JSON.stringify(reponses), bonne_reponse_id]);
    res.json({message:'Quiz créé', quiz: insertRes.rows[0]});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:'Erreur création quiz'});
  }
});

app.get('/quiz/active/:tokenQR', async(req,res) => {
  const tokenQR = req.params.tokenQR;
  try {
    const sessionRes = await pool.query('SELECT id FROM sessions WHERE token_qr=$1 AND statut=$2', [tokenQR, 'ouverte']);
    if(sessionRes.rowCount === 0) return res.status(404).json({ error:'Session non trouvée' });
    const sessionId = sessionRes.rows[0].id;
    const quizRes = await pool.query('SELECT id, question, reponses, bonne_reponse_id FROM quizzes WHERE session_id=$1 AND active=TRUE LIMIT 1', [sessionId]);
    if(quizRes.rowCount === 0) return res.json({ active:false });
    res.json({ active:true, quiz: quizRes.rows[0]});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:'Erreur récupération quiz'});
  }
});

// Réponse quiz
app.post('/quiz/answer', authMiddleware, async(req,res) => {
  if(req.user.role !== 'etudiant') return res.status(403).json({error:'Accès interdit'});
  const { quizId, reponseId } = req.body;
  if(!quizId || reponseId === undefined) return res.status(400).json({error:'Données manquantes'});
  try {
    const existRes = await pool.query('SELECT * FROM quiz_reponses_etudiants WHERE quiz_id=$1 AND user_id=$2', [quizId, req.user.id]);
    if(existRes.rowCount > 0) return res.status(409).json({ error:'Quiz déjà répondu' });
    await pool.query('INSERT INTO quiz_reponses_etudiants(quiz_id, user_id, reponse_id) VALUES ($1,$2,$3)', [quizId, req.user.id, reponseId]);
    res.json({ message:'Réponse enregistrée' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error:'Erreur enregistrement réponse' });
  }
});

// Liste étudiants connectés
app.get('/session/:sessionId/students', authMiddleware, async(req,res) => {
  if(req.user.role !== 'enseignant') return res.status(403).json({error:'Interdit'});
  const sessionId = parseInt(req.params.sessionId);
  try {
    const sessRes = await pool.query('SELECT s.*, c.enseignant_id FROM sessions s JOIN courses c ON s.course_id = c.id WHERE s.id=$1', [sessionId]);
    if(sessRes.rowCount === 0 || sessRes.rows[0].enseignant_id !== req.user.id) return res.status(403).json({error:'Accès interdit'});
    const studentsRes = await pool.query(`
      SELECT u.id, u.nom, u.prenom, l.date_login
      FROM logins l JOIN users u ON l.user_id = u.id
      WHERE l.session_id = $1 AND l.date_logout IS NULL
      ORDER BY l.date_login DESC
    `, [sessionId]);
    res.json({ students: studentsRes.rows });
  } catch(e) {
    console.error(e);
    res.status(500).json({error:'Erreur récupération étudiants'});
  }
});

// Gestion des fichiers




// Routes optimisées pour gestion des documents par nom de session
app.post('/session/:sessionName/upload', authenticateToken, upload.array('files', 10), async (req, res) => {
    try {
        const { sessionName } = req.params;
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Aucun fichier fourni' });
        }

        // Créer le dossier de session si nécessaire
        const sessionDir = path.join(__dirname, 'uploads', 'sessions', sessionName);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const uploadedFiles = [];
        
        for (const file of req.files) {
            const fileName = `${Date.now()}_${file.originalname}`;
            const filePath = path.join(sessionDir, fileName);
            
            // Déplacer le fichier vers le dossier de session
            fs.renameSync(file.path, filePath);
            uploadedFiles.push(fileName);
            
            console.log(`[UPLOAD] Fichier sauvegardé: ${sessionName}/${fileName}`);
        }

        res.json({ 
            success: true, 
            message: 'Fichiers uploadés avec succès',
            files: uploadedFiles,
            sessionName: sessionName
        });

    } catch (error) {
        console.error('[UPLOAD ERROR]', error);
        res.status(500).json({ error: 'Erreur serveur lors de l\'upload' });
    }
});

// Route pour récupérer les fichiers d'une session
app.get('/session/:sessionName/files', authenticateToken, (req, res) => {
    try {
        const { sessionName } = req.params;
        const sessionDir = path.join(__dirname, 'uploads', 'sessions', sessionName);
        
        if (!fs.existsSync(sessionDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(sessionDir).filter(file => {
            const filePath = path.join(sessionDir, file);
            return fs.statSync(filePath).isFile();
        });

        res.json(files);

    } catch (error) {
        console.error('[FILES LIST ERROR]', error);
        res.status(500).json({ error: 'Erreur lors de la récupération des fichiers' });
    }
});

// Route pour télécharger un fichier de session
app.get('/session/:sessionName/files/:fileName', authenticateToken, (req, res) => {
    try {
        const { sessionName, fileName } = req.params;
        const filePath = path.join(__dirname, 'uploads', 'sessions', sessionName, fileName);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Fichier non trouvé' });
        }

        res.download(filePath, fileName);

    } catch (error) {
        console.error('[FILE DOWNLOAD ERROR]', error);
        res.status(500).json({ error: 'Erreur lors du téléchargement' });
    }
});



// Routes optimisées pour gestion des documents par nom de session (duplicated in source; preserved)
app.post('/session/:sessionName/upload', authenticateToken, upload.array('files', 10), async (req, res) => {
    try {
        const { sessionName } = req.params;

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Aucun fichier fourni' });
        }

        // Créer le dossier de session si nécessaire
        const sessionDir = path.join(__dirname, 'uploads', 'sessions', sessionName);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const uploadedFiles = [];

        for (const file of req.files) {
            const fileName = `${Date.now()}_${file.originalname}`;
            const filePath = path.join(sessionDir, fileName);

            // Déplacer le fichier vers le dossier de session
            fs.renameSync(file.path, filePath);
            uploadedFiles.push(fileName);

            console.log(`[UPLOAD] Fichier sauvegardé: ${sessionName}/${fileName}`);
        }

        res.json({
            success: true,
            message: 'Fichiers uploadés avec succès',
            files: uploadedFiles,
            sessionName: sessionName
        });

    } catch (error) {
        console.error('[UPLOAD ERROR]', error);
        res.status(500).json({ error: 'Erreur serveur lors de l\'upload' });
    }
});

// Route pour récupérer les fichiers d'une session (duplicated in source; preserved)
app.get('/session/:sessionName/files', authenticateToken, (req, res) => {
    try {
        const { sessionName } = req.params;
        const sessionDir = path.join(__dirname, 'uploads', 'sessions', sessionName);

        if (!fs.existsSync(sessionDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(sessionDir).filter(file => {
            const filePath = path.join(sessionDir, file);
            return fs.statSync(filePath).isFile();
        });

        res.json(files);

    } catch (error) {
        console.error('[FILES LIST ERROR]', error);
        res.status(500).json({ error: 'Erreur lors de la récupération des fichiers' });
    }
});

// Route pour télécharger un fichier de session (duplicated in source; preserved)
app.get('/session/:sessionName/files/:fileName', authenticateToken, (req, res) => {
    try {
        const { sessionName, fileName } = req.params;
        const filePath = path.join(__dirname, 'uploads', 'sessions', sessionName, fileName);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Fichier non trouvé' });
        }

        res.download(filePath, fileName);

    } catch (error) {
        console.error('[FILE DOWNLOAD ERROR]', error);
        res.status(500).json({ error: 'Erreur lors du téléchargement' });
    }
});




// Démarrer le serveur
const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`[SERVER] ✅ Serveur API démarré sur le port ${PORT} avec toutes les fonctionnalités intégrées`);
  console.log('[SERVER] 📊 Fonctionnalités disponibles:');
  console.log('[SERVER] - WebRTC (diffusion enseignant, prise de parole étudiants)');
  console.log('[SERVER] - Chat en temps réel');
  console.log('[SERVER] - Questions sourdines et mains levées');
  console.log('[SERVER] - Notes partagées avec génération PDF');
  console.log('[SERVER] - Résumé automatique des notes (IA)');
  console.log('[SERVER] - Gestion de documents de cours');
  console.log('[SERVER] - Suivi de présence avec export PDF/CSV');
  console.log('[SERVER] - Système de quiz');
  console.log('[SERVER] - Historique et statistiques des sessions');
  console.log('[SERVER] - Authentification JWT');
  console.log('[SERVER] - Gestion des rôles (admin, enseignant, étudiant)');
});