const express = require('express');
const admin = require('firebase-admin');

// 1. Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// 2. Initialize Firebase Admin SDK
// Render allows you to safely inject your Service Account JSON via an Environment Variable
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Local development fallback
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

// Track the boot time so we only send notifications for NEW messages
const bootTime = admin.firestore.Timestamp.now();
console.log(`Server started at: ${bootTime.toDate().toISOString()}`);

// 3. Listen to all new messages across the entire database
db.collectionGroup('messages')
  .where('createdAt', '>=', bootTime)
  .onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async (change) => {
      // We only care about newly added messages
      if (change.type === 'added') {
        const message = change.doc.data();
        
        // Ignore messages sent by the agent
        if (message.sender === 'agent') return;

        // Path is usually: chats/{chatId}/messages/{messageId}
        const pathSegments = change.doc.ref.path.split('/');
        if (pathSegments.length < 3) return;
        const chatId = pathSegments[1];

        try {
          // Find out which agent is assigned to this chat
          const chatDoc = await db.collection('chats').doc(chatId).get();
          if (!chatDoc.exists) return;

          const chatData = chatDoc.data();
          const agentId = chatData.assignedAgent;
          
          // Skip if no agent is assigned or the agent is currently looking at the chat (unread = 0)
          if (!agentId || chatData.unreadByAgent === 0) return;

          // Get the agent's Expo Push Token
          const agentDoc = await db.collection('agents').doc(agentId).get();
          if (!agentDoc.exists) return;

          const pushToken = agentDoc.data().pushToken;
          if (!pushToken) {
            console.log(`Agent ${agentId} does not have a pushToken.`);
            return;
          }

          // Construct the Push Notification payload
          const title = chatData.userName || 'Customer';
          let body = message.text || '📷 Sent an image';
          if (body.length > 100) body = body.substring(0, 100) + '...';

          const pushPayload = {
            to: pushToken,
            sound: 'default',
            title: title,
            body: body,
            data: { chatId: chatId },
          };

          // Send the Push Notification via Expo's API
          const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Accept-encoding': 'gzip, deflate',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(pushPayload),
          });
          
          const receipt = await response.json();
          console.log(`Push sent to ${agentId}:`, receipt);

        } catch (error) {
          console.error("Error processing new message:", error);
        }
      }
    });
  }, error => {
    console.error("Firestore Listener Error:", error);
  });

// 4. Basic Health Check Endpoint for Render
app.get('/', (req, res) => {
  res.send('Atrader Notification Server is running and listening for messages!');
});

// 5. Start Server
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
