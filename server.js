const express = require('express');
const admin = require('firebase-admin');

// 1. Process safety guards (prevents unexpected process crashes on transient network blips)
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// 2. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// 3. Initialize Firebase Admin SDK
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    // Handle optional base64 encoded credentials
    if (!raw.startsWith('{')) {
      try {
        raw = Buffer.from(raw, 'base64').toString('utf-8');
      } catch (_) {}
    }
    serviceAccount = JSON.parse(raw);
    // Fix escaped newlines in private key if mangled by environment variables
    if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }
} catch (error) {
  console.error("FATAL: Could not load Firebase Service Account credentials.", error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Track previous unread counts to detect increases
const previousUnreadCounts = {};

console.log('Server started. Listening to chats collection for new messages...');

// 4. Listen to the chats collection for unreadByAgent changes
// No index required - this is a simple collection listener
const unsubscribe = db.collection('chats').onSnapshot(snapshot => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const chatId = change.doc.id;
      const chatData = change.doc.data();
      const newUnread = chatData.unreadByAgent || 0;
      const prevUnread = previousUnreadCounts[chatId] ?? null;

      // Update our local tracking
      previousUnreadCounts[chatId] = newUnread;

      // Skip on first snapshot load (prevUnread is null) to avoid 
      // sending notifications for old unread messages on startup
      if (prevUnread === null) return;

      // Only send a notification if the unread count INCREASED
      if (newUnread <= prevUnread) return;

      const agentId = chatData.assignedAgent;
      if (!agentId) return;

      console.log(`New message in chat ${chatId} for agent ${agentId}. Unread: ${prevUnread} -> ${newUnread}`);

      try {
        // Get ALL agents that have a push token
        const agentsSnap = await db.collection('agents').get();
        const pushTokens = [];
        
        agentsSnap.forEach(doc => {
          if (doc.data().pushToken) {
            pushTokens.push(doc.data().pushToken);
          }
        });

        if (pushTokens.length === 0) {
          console.log(`No agents have a pushToken saved in the database!`);
          return;
        }

        // Build notifications for EVERY agent
        const title = chatData.userName || 'Customer';
        let body = chatData.lastMessage || 'New message received';
        if (body.length > 100) body = body.substring(0, 100) + '...';

        const pushPayloads = pushTokens.map(token => ({
          to: token,
          sound: 'default',
          priority: 'high',
          title: title,
          body: body,
          data: { chatId: chatId },
          channelId: 'default',
        }));

        // Send via Expo Push API (accepts an array of messages)
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Accept-encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(pushPayloads),
        });

        const receipt = await response.json();
        console.log(`Broadcasted push notification to ${pushTokens.length} agents:`, JSON.stringify(receipt));

      } catch (error) {
        console.error("Error sending push notification:", error);
      }
    }
  });
}, error => {
  console.error("Firestore chats listener error:", error);
});

// 5. Health Check Endpoints (for Northflank liveness/readiness probes)
app.get('/', (req, res) => {
  const chatCount = Object.keys(previousUnreadCounts).length;
  res.status(200).json({
    status: 'ok',
    message: `Atrader Notification Server is running. Monitoring ${chatCount} chats.`,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: Math.floor(process.uptime()) });
});

// 6. Start the server
const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});

// 7. Graceful Shutdown (allows Northflank / Kubernetes to cleanly terminate on deploy)
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Gracefully stopping service...`);
  if (typeof unsubscribe === 'function') {
    try {
      unsubscribe();
    } catch (_) {}
  }
  server.close(() => {
    console.log('HTTP server closed. Exiting.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forced shutdown timeout reached. Exiting.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
