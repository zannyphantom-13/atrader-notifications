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
    try {
      serviceAccount = require('./serviceAccountKey.json');
    } catch (_) {
      serviceAccount = require('c:/Users/Hassan/Downloads/atrader-54ae9-firebase-adminsdk-fbsvc-6e950c5919.json');
    }
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
const previousUnreadAgentCounts = {};
const previousUnreadCustomerCounts = {};

console.log('Server started. Listening to chats collection for new messages...');

// Helper to send push payloads via Expo Push API
async function sendExpoPush(payloads) {
  if (!payloads || (Array.isArray(payloads) && payloads.length === 0)) return;
  const bodyData = Array.isArray(payloads) ? payloads : [payloads];
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyData),
    });
    const receipt = await response.json();
    return receipt;
  } catch (error) {
    console.error("Error sending push notification via Expo:", error);
  }
}

// 4. Listen to the chats collection for unread changes (both directions)
const unsubscribe = db.collection('chats').onSnapshot(snapshot => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added' || change.type === 'modified') {
      const chatId = change.doc.id;
      const chatData = change.doc.data();

      // =========================================================================
      // DIRECTION 1: Customer sent message -> Notify ONLY the assigned support agent
      // =========================================================================
      const newAgentUnread = Number(chatData.unreadByAgent || 0);
      const prevAgentUnread = previousUnreadAgentCounts[chatId] ?? null;
      previousUnreadAgentCounts[chatId] = newAgentUnread;

      if (prevAgentUnread !== null && newAgentUnread > prevAgentUnread) {
        const assignedAgentId = chatData.assignedAgent || chatData.assignedTo;
        console.log(`[Customer -> Agent] Chat ${chatId} unreadByAgent: ${prevAgentUnread} -> ${newAgentUnread}. Assigned agent: ${assignedAgentId || 'Unassigned'}`);

        try {
          let pushTokens = [];

          // Fetch all agents once, then apply preference rules:
          //   assigned chat  → assigned agent always gets it
          //                    + any other agent with pref='all' also gets it
          //   unassigned chat → only agents with pref='all'
          const agentsSnap = await db.collection('agents').get();
          const seenTokens = new Set(); // deduplicate tokens

          agentsSnap.forEach(d => {
            const agentData = d.data();
            const token = agentData.pushToken;
            if (!token || seenTokens.has(token)) return;

            const pref = agentData.notificationPreference || 'all';

            if (assignedAgentId) {
              // Is THIS agent the assigned one?
              const thisAgentId = String(agentData.agentId || d.id);
              const isAssignedAgent =
                thisAgentId === String(assignedAgentId) ||
                d.id === String(assignedAgentId);

              // Assigned agent always gets notified regardless of pref.
              // Any other agent gets notified only if pref='all'.
              if (isAssignedAgent || pref === 'all') {
                pushTokens.push(token);
                seenTokens.add(token);
              }
            } else {
              // Unassigned chat: only agents who want ALL messages
              if (pref === 'all') {
                pushTokens.push(token);
                seenTokens.add(token);
              }
            }
          });

          if (pushTokens.length > 0) {
            const title = chatData.userName || 'Customer';
            const isFirst = newAgentUnread <= 1;
            let body = isFirst
              ? (chatData.lastMessage || 'New message received')
              : `${newAgentUnread} new messages`;
            if (body.length > 100) body = body.substring(0, 100) + '...';

            const payloads = pushTokens.map(token => ({
              to: token,
              sound: 'default',
              priority: 'high',
              title: title,
              body: body,
              data: { chatId: chatId },
              channelId: 'chat_alerts_v2', // HIGH importance for heads-up pop-up
              tag: `chat_${chatId}`,
              collapseId: `chat_${chatId}`,
            }));

            const receipt = await sendExpoPush(payloads);
            console.log(`[Customer -> Agent] Push sent to ${pushTokens.length} recipient(s):`, JSON.stringify(receipt));
          } else {
            console.log(`[Customer -> Agent] No push token found for agent ${assignedAgentId}`);
          }
        } catch (err) {
          console.error("[Customer -> Agent] Error notifying agent:", err);
        }
      }

      // =========================================================================
      // DIRECTION 2: Agent sent message -> Notify ONLY the customer
      // User requirement: main app notification should be "New message awaiting you"
      // =========================================================================
      const newCustomerUnread = Math.max(
        Number(chatData.unreadByCustomer || 0),
        Number(chatData.unreadByUser || 0),
        Number(chatData.unreadCount || 0)
      );
      const prevCustomerUnread = previousUnreadCustomerCounts[chatId] ?? null;
      previousUnreadCustomerCounts[chatId] = newCustomerUnread;

      // STRICT CHECK: Only notify customer when message is FROM AN AGENT in a gift card trade/support chat!
      // NEVER notify on system welcome messages, trade ongoing status, or closed chat messages.
      const isFromAgent = chatData.lastMessageSender === 'agent' || chatData.senderType === 'agent';
      const isSystem =
        chatData.lastMessageSender === 'system' ||
        chatData.senderType === 'system' ||
        (chatData.lastMessage && chatData.lastMessage.toLowerCase().includes('ongoing')) ||
        (chatData.lastMessage && chatData.lastMessage.toLowerCase().includes('welcome')) ||
        (chatData.lastMessage && chatData.lastMessage.toLowerCase().includes('submitted a trade'));

      if (prevCustomerUnread !== null && newCustomerUnread > prevCustomerUnread && isFromAgent && !isSystem) {
        console.log(`[Agent -> Customer] Chat ${chatId} unreadByCustomer: ${prevCustomerUnread} -> ${newCustomerUnread}`);

        const customerToken = chatData.userExpoPushToken;
        if (customerToken && customerToken.startsWith('ExponentPushToken')) {
          const isTradeChat = !!chatData.tradeId;
          const cardLabel = chatData.cardName || chatData.cardCategory;
          const notifTitle = isTradeChat && cardLabel ? `Atrader Support — ${cardLabel}` : 'Atrader Support';
          
          const notifBody = "New - Message awaiting you";

          const payload = {
            to: customerToken,
            sound: 'default',
            priority: 'high',
            title: notifTitle,
            body: notifBody,
            channelId: 'chat_alerts',
            tag: `chat_${chatId}`,
            collapseId: `chat_${chatId}`,
            data: {
              chatId: chatId,
              conversationId: chatId,
              tradeId: chatData.tradeId || null,
              cardName: chatData.cardName || null,
              cardCategory: chatData.cardCategory || null,
              senderName: notifTitle,
              preview: notifBody,
              screen: `/(protected)/(features)/trade-chat?chatId=${chatId}&type=existing`
            }
          };

          try {
            const receipt = await sendExpoPush([payload]);
            console.log(`[Agent -> Customer] Push sent to customer ${customerToken}:`, JSON.stringify(receipt));
          } catch (err) {
            console.error("[Agent -> Customer] Error notifying customer:", err);
          }
        } else {
          console.log(`[Agent -> Customer] Chat ${chatId} has no valid customer userExpoPushToken: ${customerToken}`);
        }
      }
    }
  });
}, error => {
  console.error("Firestore chats listener error:", error);
});

// 5. Health Check Endpoints (for Northflank liveness/readiness probes)
app.get('/', (req, res) => {
  const agentChatCount = Object.keys(previousUnreadAgentCounts).length;
  const customerChatCount = Object.keys(previousUnreadCustomerCounts).length;
  res.status(200).json({
    status: 'ok',
    message: `Atrader Notification Server is running. Monitoring ${agentChatCount} agent chats, ${customerChatCount} customer chats.`,
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
