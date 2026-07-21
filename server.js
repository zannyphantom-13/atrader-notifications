const express = require('express');
const admin = require('firebase-admin');

// 1. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// 2. Initialize Firebase Admin SDK
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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

// 3. Listen to the chats collection for unreadByAgent changes
// No index required - this is a simple collection listener
db.collection('chats').onSnapshot(snapshot => {
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

// 4. Health Check Endpoint (keeps Render awake if pinged)
app.get('/', (req, res) => {
  const chatCount = Object.keys(previousUnreadCounts).length;
  res.send(`Atrader Notification Server is running. Monitoring ${chatCount} chats.`);
});

// 5. Start the server
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
